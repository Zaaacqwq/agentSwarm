import { randomBytes } from "node:crypto";
import { and, eq, inArray, desc } from "drizzle-orm";
import type { RunReport } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { RunLimits } from "../db/schema.ts";
import { newId } from "../crypto/tokens.ts";
import { gitOk, type GitRunner } from "../github/git.ts";
import type { GitHubService } from "../github/github-service.ts";
import type { ProjectRow, ProjectService } from "../projects/project-service.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { AgentService } from "./agent-service.ts";

type RunRow = typeof schema.runs.$inferSelect;

/** Tree limits (PLAN.md section 5, confirmed for R2). */
export const TREE_LIMITS = {
  maxDepth: 3, maxLivePerTree: 12, defaultRootBudgetUsd: 2, reviewBudgetUsd: 0.25,
  /** By default a child gets this share of what its parent has left. */
  childShare: 0.3,
  /** A parent always keeps this share of its own budget (at least $0.05) for its own turns. */
  reserveShare: 0.15,
} as const;
export const TERMINAL = new Set<RunRow["status"]>(["succeeded", "failed", "cancelled"]);
const LIVE: RunRow["status"][] = ["queued", "running", "waiting"];
const DIFF_LIMIT = 60_000;

export class TreeError extends Error {}

export interface TreeDeps {
  readonly db: Db;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly github: GitHubService;
  readonly git: GitRunner;
  readonly backend: WorkstationBackend;
  readonly limits: RunLimits;
}

export interface SpawnInput {
  readonly name: string;
  readonly role: string;
  readonly brief: string;
  readonly budgetUsd?: number;
  readonly modelId?: string;
}

const slug = (text: string, max: number) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/**
 * The agent tree: who may spawn, what each node may spend, branch names, reviews and merges.
 * Branches: swarm/<project>/<tree>/<node>; nodes are flat, depth is encoded with "--" (git cannot
 * hold both a/b and a/b/c as branches).
 */
export class TreeService {
  private readonly deps: TreeDeps;

  constructor(deps: TreeDeps) {
    this.deps = deps;
  }

  /** A new tree's root: swarm/<project>/<tree>/root. */
  rootNames(project: ProjectRow, title: string): { treeId: string; branch: string; scope: string } {
    const treeId = `${slug(title, 32) || "task"}-${randomBytes(3).toString("hex")}`;
    return { treeId, branch: `swarm/${project.slug}/${treeId}/root`, scope: `worktrees/${project.slug}/${treeId}--root` };
  }

  run(id: string): RunRow {
    const row = this.deps.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    if (!row) throw new TreeError(`No run ${id}`);
    return row;
  }

  children(parentId: string): RunRow[] {
    return this.deps.db.select().from(schema.runs).where(eq(schema.runs.parentRunId, parentId)).all();
  }

  /** A direct child of `parent`, or an error the agent can read. */
  child(parent: RunRow, id: string): RunRow {
    const row = this.deps.db.select().from(schema.runs).where(and(eq(schema.runs.id, id), eq(schema.runs.parentRunId, parent.id))).get();
    if (!row) throw new TreeError(`${id} is not one of your sub-agents`);
    return row;
  }

  descendants(id: string): RunRow[] {
    const out: RunRow[] = [];
    const queue = [id];
    while (queue.length) {
      const next = this.children(queue.shift()!);
      out.push(...next);
      queue.push(...next.map((r) => r.id));
    }
    return out;
  }

  /** What this node may still spend itself: its budget minus what it handed to children. */
  ownCap(run: RunRow): number | null {
    if (run.budgetUsd === null) return null;
    return run.budgetUsd - this.children(run.id).reduce((s, c) => s + (c.budgetUsd ?? 0), 0);
  }

  async spawn(parent: RunRow, input: SpawnInput, now = Date.now()): Promise<RunRow> {
    const { db, agents, projects } = this.deps;
    if (parent.kind !== "task") throw new TreeError("Reviewers cannot spawn agents");
    if (parent.depth >= TREE_LIMITS.maxDepth) throw new TreeError(`Depth limit reached (${TREE_LIMITS.maxDepth}); do this part yourself`);
    const live = db.select({ id: schema.runs.id }).from(schema.runs).where(and(eq(schema.runs.treeId, parent.treeId!), inArray(schema.runs.status, LIVE))).all().length;
    if (live >= TREE_LIMITS.maxLivePerTree) throw new TreeError(`This tree already has ${live} unfinished agents (limit ${TREE_LIMITS.maxLivePerTree}); wait for some to finish`);
    const budget = this.carve(parent, input.budgetUsd);
    const project = projects.get(parent.projectId);
    const parentAgent = agents.get(parent.agentId);
    const name = input.name.trim().slice(0, 30) || "helper";
    const agent = agents.createEphemeral(parentAgent, { name, role: input.role.trim().slice(0, 40) || "developer", ...(input.modelId ? { modelId: input.modelId } : {}) }, now);
    const node = this.uniqueNode(parent, slug(name, 20) || "part");
    const base = (await this.inMirror(project, parent.branch)) ? parent.branch : parent.baseBranch;
    const row: RunRow = {
      id: newId("run"), agentId: agent.id, projectId: project.id, title: name, brief: input.brief,
      branch: `swarm/${project.slug}/${parent.treeId}/${node}`, worktreeScope: `worktrees/${project.slug}/${parent.treeId}--${node}`,
      workstationId: null, status: "queued", pendingMessage: this.childBrief(parentAgent.name, input.brief, base ?? project.defaultBranch),
      report: null, error: null, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, limits: this.deps.limits,
      createdAt: now, startedAt: null, endedAt: null, treeId: parent.treeId, parentRunId: parent.id, depth: parent.depth + 1,
      baseBranch: base, budgetUsd: budget, kind: "task", reviewOf: null, review: null, mergedAt: null, prUrl: null, waitingFor: null,
    };
    db.insert(schema.runs).values(row).run();
    return row;
  }

  /** A reviewer for a finished child: it checks out the child's branch read-only and gets the diff. */
  async startReview(parent: RunRow, childId: string, now = Date.now()): Promise<RunRow> {
    const { db, agents, projects } = this.deps;
    const child = this.child(parent, childId);
    if (child.kind !== "task") throw new TreeError("Only task agents can be reviewed");
    if (child.status !== "succeeded") throw new TreeError(`${child.title} has not finished successfully (it is ${child.status})`);
    if (!this.lastPushed(child)) throw new TreeError(`${child.title} has not pushed its branch; ask it to git_push`);
    const project = projects.get(parent.projectId);
    const base = child.baseBranch ?? project.defaultBranch;
    const diff = await this.diff(project, base, child.branch);
    const reviewer = agents.createEphemeral(agents.get(parent.agentId), { name: `${child.title}-review`.slice(0, 30), role: "reviewer" }, now);
    const n = this.children(parent.id).filter((r) => r.kind === "review" && r.reviewOf === child.id).length + 1;
    const childNode = child.branch.split("/").pop()!;
    const row: RunRow = {
      id: newId("run"), agentId: reviewer.id, projectId: project.id, title: `Review ${child.title}`, brief: `Review ${child.branch}`,
      branch: child.branch, worktreeScope: `worktrees/${project.slug}/${parent.treeId}--${childNode}--review-${n}`,
      workstationId: null, status: "queued", pendingMessage: reviewBrief(child, base, diff),
      report: null, error: null, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, limits: this.deps.limits,
      createdAt: now, startedAt: null, endedAt: null, treeId: parent.treeId, parentRunId: parent.id, depth: parent.depth + 1,
      baseBranch: base, budgetUsd: this.carve(parent, TREE_LIMITS.reviewBudgetUsd, true), kind: "review", reviewOf: child.id,
      review: null, mergedAt: null, prUrl: null, waitingFor: null,
    };
    db.insert(schema.runs).values(row).run();
    return row;
  }

  recordVerdict(review: RunRow, approved: boolean, comments: string): void {
    if (review.kind !== "review" || !review.reviewOf) throw new TreeError("Only reviewers give verdicts");
    this.deps.db.update(schema.runs).set({ review: { approved, comments, reviewRunId: review.id } }).where(eq(schema.runs.id, review.reviewOf)).run();
  }

  /** Merges an approved child's branch into the parent's worktree, inside the parent's sandbox. */
  async merge(parent: RunRow, childId: string, signal?: AbortSignal, now = Date.now()): Promise<string> {
    const child = this.child(parent, childId);
    if (child.mergedAt) throw new TreeError(`${child.title} is already merged`);
    if (!child.review?.approved) throw new TreeError(`${child.title} has not been approved by a review; call review_agent first`);
    if (!parent.workstationId) throw new TreeError("You have no workstation right now");
    const res = await this.deps.backend.call<{ merged: boolean; head: string | null; conflicts: string[] }>(
      parent.workstationId,
      { op: "git.merge", scope: parent.worktreeScope, branch: child.branch, message: `Merge ${child.branch} (${child.title})` },
      signal ? { signal } : {},
    );
    if (!res.merged) {
      return `Merge of ${child.branch} stopped on conflicts in: ${res.conflicts.join(", ")}. Nothing was changed. Resolve them yourself (for example merge, fix and commit with ws_bash) or spawn a sub-agent to reconcile the branches.`;
    }
    this.deps.db.update(schema.runs).set({ mergedAt: now }).where(eq(schema.runs.id, child.id)).run();
    return `Merged ${child.branch} into your branch (now ${res.head?.slice(0, 10)}). Run the tests, then git_push.`;
  }

  async openPullRequest(root: RunRow, title: string, body: string): Promise<string> {
    if (root.depth !== 0 || root.kind !== "task") throw new TreeError("Only the root agent opens the pull request");
    if (!this.lastPushed(root)) throw new TreeError("Push your branch first (git_push)");
    const project = this.deps.projects.get(root.projectId);
    const unmerged = this.children(root.id).filter((c) => c.kind === "task" && c.status === "succeeded" && !c.mergedAt);
    const note = unmerged.length ? `\n\nNot merged: ${unmerged.map((c) => c.branch).join(", ")}` : "";
    const url = await this.deps.github.client.createPullRequest(await this.deps.github.token(), project.githubRepo, {
      head: root.branch, base: project.defaultBranch, title,
      body: `${body.trim()}${note}\n\n---\nOpened by an agentSwarm agent from \`${root.branch}\`. Merging is left to a person.`,
    });
    this.deps.db.update(schema.runs).set({ prUrl: url }).where(eq(schema.runs.id, root.id)).run();
    return url;
  }

  /** What a waiting parent is told when its children finish. */
  resultsMessage(ids: string[]): string {
    const parts = ids.map((id) => {
      const r = this.run(id);
      if (r.kind === "review") {
        const target = r.reviewOf ? this.run(r.reviewOf) : null;
        const v = target?.review;
        return [`### Review of ${target?.title ?? "?"} (${target?.id ?? "?"}): ${v ? (v.approved ? "APPROVED" : "CHANGES REQUESTED") : `no verdict (${r.status})`}`, v?.comments ?? r.error ?? ""].join("\n");
      }
      const rep = r.report as RunReport | null;
      const pushed = this.lastPushed(r);
      return [
        `### ${r.title} (${r.id}) — ${r.status}`,
        `Branch: ${r.branch}${pushed ? ` (pushed ${pushed.slice(0, 10)})` : " (not pushed)"}`,
        rep ? `Summary: ${rep.summary}\nTests: ${rep.tests}` : "",
        rep?.unfinished.length ? `Unfinished: ${rep.unfinished.join("; ")}` : "",
        rep?.recommendations?.length ? `Recommendations: ${rep.recommendations.join("; ")}` : "",
        r.error ? `Error: ${r.error}` : "",
      ].filter(Boolean).join("\n");
    });
    return `Your sub-agents reported back.\n\n${parts.join("\n\n")}`;
  }

  lastPushed(run: RunRow): string | null {
    const row = this.deps.db.select().from(schema.gitPushes).where(and(eq(schema.gitPushes.runId, run.id), eq(schema.gitPushes.status, "pushed")))
      .orderBy(desc(schema.gitPushes.id)).limit(1).get();
    return row?.headSha ?? null;
  }

  /** Budget for a new child, taken out of what the parent may still spend. */
  private carve(parent: RunRow, requested: number | undefined, small = false): number {
    const cap = this.ownCap(parent) ?? parent.limits.maxCostUsd;
    const remaining = cap - parent.costUsd;
    const reserve = Math.max(0.05, (parent.budgetUsd ?? parent.limits.maxCostUsd) * TREE_LIMITS.reserveShare);
    const spare = remaining - reserve;
    const amount = requested ?? (small ? Math.min(TREE_LIMITS.reviewBudgetUsd, spare * 0.5) : spare * TREE_LIMITS.childShare);
    if (amount < 0.01 || amount > spare) {
      throw new TreeError(`Not enough budget: you can give away $${Math.max(0, spare).toFixed(2)} (keeping $${reserve.toFixed(2)} for yourself) and asked for $${amount.toFixed(2)}`);
    }
    return Math.round(amount * 10_000) / 10_000;
  }

  private uniqueNode(parent: RunRow, name: string): string {
    const parentNode = parent.branch.split("/").pop()!;
    const base = parentNode === "root" ? name : `${parentNode}--${name}`;
    const taken = new Set(this.deps.db.select({ b: schema.runs.branch }).from(schema.runs).where(eq(schema.runs.treeId, parent.treeId!)).all().map((r) => r.b.split("/").pop()));
    let node = base;
    for (let n = 2; taken.has(node); n++) node = `${base}-${n}`;
    return node;
  }

  private childBrief(parentName: string, brief: string, base: string): string {
    return [
      brief.trim(),
      "",
      `(You are a sub-agent of ${parentName}. Your branch starts from ${base}. When the work is done: run the tests, git_commit, git_push, then report. Your parent only sees your report.)`,
    ].join("\n");
  }

  private async inMirror(project: ProjectRow, branch: string | null): Promise<boolean> {
    if (!branch) return false;
    return (await this.deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: project.mirrorPath })).code === 0;
  }

  private async diff(project: ProjectRow, base: string, head: string): Promise<string> {
    const stat = await gitOk(this.deps.git, ["diff", "--stat", `refs/heads/${base}...refs/heads/${head}`], { cwd: project.mirrorPath });
    const full = await gitOk(this.deps.git, ["diff", `refs/heads/${base}...refs/heads/${head}`], { cwd: project.mirrorPath });
    return `${stat}\n${full.length > DIFF_LIMIT ? `${full.slice(0, DIFF_LIMIT)}\n… diff truncated; read the files in your worktree` : full}`;
  }
}

function reviewBrief(child: RunRow, base: string, diff: string): string {
  const rep = child.report as RunReport | null;
  return [
    `Review the work on ${child.branch} (based on ${base}). Your worktree is checked out at that branch.`,
    "",
    "## What the agent was asked to do",
    child.brief.trim(),
    "",
    "## What it reports",
    rep ? `${rep.summary}\nTests: ${rep.tests}${rep.unfinished.length ? `\nUnfinished: ${rep.unfinished.join("; ")}` : ""}` : "(no report)",
    "",
    "## The diff",
    "```diff",
    diff,
    "```",
    "",
    "Check that the change does what was asked, is correct, and does not break anything: read the code and run the tests.",
    "Then call review_verdict: approved true only if it can be merged as is; otherwise false with specific, actionable comments.",
  ].join("\n");
}
