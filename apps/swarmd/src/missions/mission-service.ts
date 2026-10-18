import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { CreateMission, MissionMessageView, MissionView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { MissionKind, MissionStage } from "../db/schema.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { GitRunner } from "../github/git.ts";
import type { PullRequestState } from "../github/github-client.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { AgentService } from "../agents/agent-service.ts";
import { TERMINAL, TreeError, type TreeService } from "../agents/tree-service.ts";
import type { TreeCleanup } from "../agents/cleanup.ts";
import { WAIT_FOR_USER, type RunBinding, type RunHooks, type RunOpening, type RunRow, type RunService } from "../agents/run-service.ts";
import { pageWindow, type WebAccess } from "../web/web-access.ts";
import { FetchError } from "../web/web-fetch.ts";
import { MISSION_FINISH, changesBrief, intakeBrief, missionPromptSection, stageBrief, type BriefContext } from "./briefs.ts";
import { fileTicketTool, missionTools, webTools, type WebToolOps } from "./mission-tools.ts";
import { ENDED, GATES, STAGE_LABEL, WORKING, afterStageDone, canMove, requiredDocs, stageTools, DOC_NAMES, type Actor, type Flow } from "./stages.ts";

export type MissionRow = typeof schema.missions.$inferSelect;
type MessageRow = typeof schema.missionMessages.$inferSelect;
type Source = MessageRow["source"];

/** How a mission was started, beyond what you asked (R5). */
export interface CreateOptions {
  readonly origin?: MissionRow["origin"];
  /** A title instead of the idea's first line (Linear: "ZAC-42 the ticket's title"). */
  readonly title?: string;
}

const flowOf = (m: Pick<MissionRow, "kind" | "fast">): Flow => ({ kind: m.kind, fast: m.fast });
/** Which kinds each kind of project can run: local projects never reach GitHub, so no pull requests. */
const KINDS_FOR: Record<"github" | "local", readonly MissionKind[]> = { github: ["feature", "bug", "research"], local: ["research", "experiment"] };

export const DEFAULT_MISSION_BUDGET_USD = 3;
const TREE_TOOLS = new Set(["spawn_agent", "wait_agents", "message_agent", "cancel_agent", "review_agent", "merge_agent"]);
/** Taken away in the read-only stages (intake, retro). */
const WRITE_TOOLS = new Set(["ws_write", "ws_edit", "git_commit", "git_push"]);

export interface MissionDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly runs: RunService;
  readonly tree: TreeService;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly git: GitRunner;
  readonly web: WebAccess;
  readonly cleanup: TreeCleanup;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

const slug = (text: string, max: number) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** Data from the web or other agents, fenced so it reads as information. */
function fenced(text: string): string {
  return `<<<untrusted\n${text.replaceAll(">>>", "> > >").replaceAll("<<<", "< < <")}\n>>>`;
}

/**
 * Missions: one idea through the pipeline. The lead's run carries every stage (one branch, one
 * worktree, one conversation); this service decides the stage, the lead's tools in it, and the gates.
 */
export class MissionService implements RunHooks {
  private readonly deps: MissionDeps;

  private openingSource: ((m: MissionRow) => Promise<RunOpening | null>) | null = null;
  private ticketFiler: ((m: MissionRow, agent: string, input: { title: string; description: string; kind: "feature" | "bug" | "research" }) => string) | null = null;

  /** R7: lets a ticket's lead put follow-ups in the backlog (file_ticket). */
  onFileTicket(filer: NonNullable<MissionService["ticketFiler"]>): void {
    this.ticketFiler = filer;
  }

  /** R7: where a mission's lead gets what came with the request (a ticket's pictures). */
  onOpening(source: (m: MissionRow) => Promise<RunOpening | null>): void {
    this.openingSource = source;
  }

  async opening(run: RunRow): Promise<RunOpening | null> {
    const m = this.missionOf(run);
    if (!m || run.id !== m.rootRunId || !this.openingSource) return null;
    return this.openingSource(m);
  }

  constructor(deps: MissionDeps) {
    this.deps = deps;
  }

  // ---- queries --------------------------------------------------------------------------

  list(limit = 100): MissionView[] {
    return this.deps.db.select().from(schema.missions).orderBy(desc(schema.missions.createdAt)).limit(Math.min(limit, 200)).all().map((m) => this.toView(m));
  }

  row(id: string): MissionRow {
    const row = this.deps.db.select().from(schema.missions).where(eq(schema.missions.id, id)).get();
    if (!row) throw notFound("No such mission");
    return row;
  }

  view(id: string): MissionView {
    return this.toView(this.row(id));
  }

  byThread(threadId: string): MissionRow | null {
    return this.deps.db.select().from(schema.missions).where(eq(schema.missions.discordThreadId, threadId)).get() ?? null;
  }

  messages(id: string, after = 0, limit = 500): MissionMessageView[] {
    this.row(id);
    return this.deps.db.select().from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, id), gt(schema.missionMessages.id, after)))
      .orderBy(asc(schema.missionMessages.id)).limit(Math.min(limit, 1000)).all().map(messageView);
  }

  /** The plan you are asked to approve now: the latest approval message (older buttons are stale). */
  latestApproval(id: string): number | null {
    const row = this.deps.db.select({ id: schema.missionMessages.id }).from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, id), eq(schema.missionMessages.kind, "approval")))
      .orderBy(desc(schema.missionMessages.id)).limit(1).get();
    return row?.id ?? null;
  }

  // ---- what the person does -------------------------------------------------------------

  create(actor: string, input: CreateMission, source: Source = "dashboard", now = Date.now(), opts: CreateOptions = {}): MissionView {
    const project = this.deps.projects.get(input.projectId);
    const kind = input.kind ?? (project.kind === "local" ? "experiment" : "feature");
    if (!KINDS_FOR[project.kind].includes(kind)) throw badRequest(`A ${kind} cannot run in ${project.kind === "local" ? "a local project" : "a GitHub project"}`);
    const lead = this.pickLead(project.id, input.agentId);
    const idea = input.idea.trim();
    const title = (opts.title ?? (idea.split("\n")[0] ?? idea)).slice(0, 80).trim() || "Mission";
    const id = newId("msn");
    const docsPath = `docs/agentswarm/${slug(title, 32) || "mission"}-${randomBytes(3).toString("hex")}`;
    // Bugs take the short path: reproduce and plan, then the gate.
    const fast = kind === "bug" ? true : input.fast ?? false;
    const brief = intakeBrief({ intent: idea, docs: docsPath, fast, defaultBranch: project.defaultBranch, kind });
    // The run cannot reach a hook before the mission row exists: it starts executing only after an await.
    const run = this.deps.runs.create(actor, lead.id, { title, brief, budgetUsd: input.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD }, now, id);
    this.deps.db.insert(schema.missions).values({
      id, projectId: project.id, title, intent: idea, stage: "intake", fast, leadAgentId: lead.id, rootRunId: run.id, treeId: run.treeId!,
      docsPath, pendingStage: null, stageSummary: null, retro: null, docs: [], discordThreadId: null, error: null,
      createdAt: now, updatedAt: now, endedAt: null, kind, origin: opts.origin ?? (source === "discord" ? "discord" : source === "linear" ? "linear" : "dashboard"),
    }).run();
    audit(this.deps.db, actor, "mission.create", id, { projectId: project.id, fast, kind, source }, now);
    this.emit(id);
    this.post(id, "user", "text", idea, source, null, now);
    return this.view(id);
  }

  /** Your message in the thread: an answer, a steer, or (at the plan gate) a change request. */
  reply(actor: string, id: string, text: string, source: Source, discordMessageId: string | null = null): MissionView {
    const m = this.row(id);
    if (ENDED.has(m.stage)) throw conflict(`This mission is ${m.stage}`);
    this.post(id, "user", "text", text, source, discordMessageId);
    if (m.stage === "awaiting_approval") {
      this.post(id, "system", "text", "Taken as a change request: the plan goes back to planning. To approve it instead, use the Approve button.", "agentswarm");
      return this.requestChanges(actor, id, text, null);
    }
    this.deps.runs.message(actor, m.rootRunId, text);
    return this.view(id);
  }

  approve(actor: string, id: string): MissionView {
    const m = this.row(id);
    if (m.stage !== "awaiting_approval") throw conflict(`There is no plan waiting for approval (the mission is in ${STAGE_LABEL[m.stage].toLowerCase()})`);
    audit(this.deps.db, actor, "mission.approve", id);
    this.move(m, "building", "person");
    return this.view(id);
  }

  /** `source` null: the comment is already in the conversation (a reply at the gate). */
  requestChanges(actor: string, id: string, comment: string, source: Source | null = "dashboard"): MissionView {
    const m = this.row(id);
    if (m.stage !== "awaiting_approval") throw conflict("There is no plan waiting for approval");
    if (source) this.post(id, "user", "text", `Changes requested: ${comment}`, source);
    audit(this.deps.db, actor, "mission.request_changes", id);
    this.move(m, "planning", "person", { comment });
    return this.view(id);
  }

  cancel(actor: string, id: string): MissionView {
    const m = this.row(id);
    if (ENDED.has(m.stage)) throw conflict(`This mission is already ${m.stage}`);
    audit(this.deps.db, actor, "mission.cancel", id);
    this.move(m, "cancelled", "person");
    return this.view(id);
  }

  setBudget(actor: string, id: string, budgetUsd: number): MissionView {
    const m = this.row(id);
    const root = this.deps.tree.run(m.rootRunId);
    const spent = this.deps.tree.subtreeCost(root);
    if (budgetUsd < spent + 0.05) throw badRequest(`The mission has already spent $${spent.toFixed(2)}; the budget must be more than that`);
    this.deps.db.update(schema.runs).set({ budgetUsd }).where(eq(schema.runs.id, root.id)).run();
    audit(this.deps.db, actor, "mission.budget", id, { budgetUsd });
    this.post(id, "system", "text", `Budget set to $${budgetUsd.toFixed(2)} (spent so far: $${spent.toFixed(2)}).`, "agentswarm");
    this.emit(id);
    return this.view(id);
  }

  setThread(id: string, threadId: string): void {
    this.deps.db.update(schema.missions).set({ discordThreadId: threadId }).where(eq(schema.missions.id, id)).run();
    this.emit(id);
  }

  markDelivered(messageId: number, discordMessageId: string): void {
    this.deps.db.update(schema.missionMessages).set({ discordMessageId }).where(eq(schema.missionMessages.id, messageId)).run();
  }

  // ---- what GitHub does -----------------------------------------------------------------

  /** From the pull request watcher, for a mission's root; idempotent. */
  async pullRequestSettled(root: RunRow, state: PullRequestState): Promise<void> {
    const m = this.row(root.missionId!);
    if (state === "merged" && (m.stage === "verifying" || m.stage === "awaiting_merge")) {
      this.post(m.id, "system", "text", `The pull request was merged: ${root.prUrl}`, "agentswarm");
      this.move(m, "retro", "github", { prUrl: root.prUrl ?? "" });
    } else if (state === "closed" && !ENDED.has(m.stage)) {
      this.post(m.id, "system", "text", "The pull request was closed without merging, so the mission is cancelled.", "agentswarm");
      this.move(m, "cancelled", "github");
    } else if (ENDED.has(m.stage) && !root.cleanedAt) {
      await this.deps.cleanup.cleanWhenSettled(m.treeId);
    }
  }

  /** Ended missions whose cleanup never completed (timed out, interrupted by a restart, or a step failed). */
  async sweep(): Promise<void> {
    const ended = this.deps.db.select().from(schema.missions).where(inArray(schema.missions.stage, ["done", "cancelled"]))
      .orderBy(desc(schema.missions.updatedAt)).limit(50).all();
    for (const m of ended) {
      const root = this.deps.tree.run(m.rootRunId);
      if (root.cleanedAt) continue;
      // An open pull request is left alone; the watcher cleans up when it is merged or closed.
      if (root.prUrl && root.prState !== "merged" && root.prState !== "closed") continue;
      await this.deps.cleanup.clean(m.treeId).catch((e: Error) => this.deps.log("mission cleanup deferred", { missionId: m.id, error: e.message }));
    }
  }

  // ---- stage changes --------------------------------------------------------------------

  /** Moves the mission if `by` may, then does what entering the stage means. */
  private move(m: MissionRow, to: MissionStage, by: Actor, ctx: { comment?: string; prUrl?: string } = {}, now = Date.now()): boolean {
    if (!canMove(m.stage, to, by, flowOf(m))) {
      this.deps.log("mission move refused", { missionId: m.id, from: m.stage, to, by });
      return false;
    }
    this.deps.db.update(schema.missions).set({ stage: to, pendingStage: null, error: null, updatedAt: now, ...(ENDED.has(to) ? { endedAt: now } : {}) })
      .where(eq(schema.missions.id, m.id)).run();
    this.post(m.id, "system", "stage", `Stage: ${STAGE_LABEL[to]}`, "agentswarm", null, now);
    const brief = this.briefContext(m);
    const root = this.deps.tree.run(m.rootRunId);
    switch (to) {
      case "research": case "discussion": case "building": case "verifying":
        this.deliver(m, stageBrief(to, brief));
        break;
      case "planning":
        this.deliver(m, ctx.comment ? changesBrief(brief, ctx.comment) : stageBrief("planning", brief));
        break;
      case "awaiting_merge":
        this.post(m.id, "system", "text", `The pull request is ready: ${root.prUrl}\nMerge it on GitHub when you are happy with it (or close it to drop the mission). agentSwarm checks every few minutes.`, "agentswarm");
        break;
      case "retro":
        this.deliver(m, stageBrief("retro", brief, `The person merged the pull request ${ctx.prUrl ?? root.prUrl ?? ""}.`));
        break;
      case "done":
        void this.deps.cleanup.cleanWhenSettled(m.treeId).catch((e: Error) => this.deps.log("cleanup failed", { missionId: m.id, error: e.message }));
        break;
      case "cancelled": {
        const live = [root, ...this.deps.tree.descendants(root.id)].some((r) => !TERMINAL.has(r.status));
        if (live) this.deps.runs.cancel("system", root.id);
        // An open pull request is left to you; it is cleaned up when you merge or close it.
        if (!(root.prUrl && root.prState !== "merged" && root.prState !== "closed")) {
          void this.deps.cleanup.cleanWhenSettled(m.treeId).catch((e: Error) => this.deps.log("cleanup failed", { missionId: m.id, error: e.message }));
        }
        break;
      }
      default:
    }
    this.emit(m.id);
    return true;
  }

  private deliver(m: MissionRow, text: string): void {
    this.deps.runs.message("system", m.rootRunId, text, Date.now(), "agentswarm");
  }

  private briefContext(m: MissionRow): BriefContext {
    const project = this.deps.projects.get(m.projectId);
    return { intent: m.intent, docs: m.docsPath, fast: m.fast, defaultBranch: project.defaultBranch, kind: m.kind };
  }

  // ---- run hooks ------------------------------------------------------------------------

  prompt(run: RunRow): { section: string[]; finish: string } | null {
    const m = this.missionOf(run);
    if (!m || m.rootRunId !== run.id) return null;
    const key = this.linearKey(m.id);
    const section = missionPromptSection(m.docsPath);
    return { section: key ? [...section, `- This mission is Linear ticket ${key}: start every commit message with "${key}: ".`] : section, finish: MISSION_FINISH };
  }

  pullRequest(run: RunRow, title: string, body: string): { title: string; body: string } {
    const m = this.missionOf(run);
    const key = m && m.rootRunId === run.id ? this.linearKey(m.id) : null;
    if (!key) return { title, body };
    return { title: title.startsWith(key) ? title : `${key} ${title}`, body: `${body.trim()}\n\nFixes ${key}` };
  }

  private linearKey(missionId: string): string | null {
    return this.deps.db.select({ key: schema.linearSessions.issueKey }).from(schema.linearSessions).where(eq(schema.linearSessions.missionId, missionId)).get()?.key ?? null;
  }

  tools(run: RunRow, binding: RunBinding): ReturnType<RunHooks["tools"]> {
    const m = this.missionOf(run);
    if (!m) return null;
    // Sub-agents: researchers get the web while the mission researches.
    if (m.rootRunId !== run.id) return m.stage === "research" ? { add: webTools(this.webOps(run, binding)) } : null;
    const t = stageTools(m.stage);
    const keep = (name: string) => {
      if (name === "report") return false;
      if (name === "open_pull_request") return t.pullRequest;
      if (TREE_TOOLS.has(name)) return t.tree;
      if (t.workstation === "read") return !WRITE_TOOLS.has(name);
      return true;
    };
    const ops = {
      tell: (text: string) => void this.post(m.id, "lead", "text", text, "agentswarm"),
      ask: (question: string) => {
        this.post(m.id, "lead", "question", question, "agentswarm");
        binding.waitForUser();
      },
      stageDone: (summary: string) => this.finishStage(m.id, summary, false),
      requestApproval: (summary: string) => this.finishStage(m.id, summary, true),
    };
    const filer = this.ticketFiler;
    const file = m.origin === "ticket" && filer ? [fileTicketTool((input) => filer(m, this.deps.agents.get(run.agentId).name, input))] : [];
    return { keep, add: [...missionTools(ops, t), ...(t.web ? webTools(this.webOps(run, binding)) : []), ...file] };
  }

  ended(run: RunRow): void {
    const m = this.missionOf(run);
    if (!m || m.rootRunId !== run.id) return;
    if (run.status === "waiting") return this.emit(m.id);
    if (run.status === "cancelled") {
      if (!ENDED.has(m.stage)) {
        this.post(m.id, "system", "text", "The lead was cancelled, so the mission is cancelled.", "agentswarm");
        this.move(m, "cancelled", "system");
      }
      return;
    }
    if (run.status === "failed") {
      if (ENDED.has(m.stage)) return;
      this.deps.db.update(schema.missions).set({ error: run.error, pendingStage: null, updatedAt: Date.now() }).where(eq(schema.missions.id, m.id)).run();
      this.post(m.id, "system", "error", `The lead stopped: ${run.error ?? "unknown error"}\nReply here to let it continue.`, "agentswarm");
      return this.emit(m.id);
    }
    if (run.status !== "succeeded") return;
    if (m.pendingStage) {
      const to = m.pendingStage;
      if (!canMove(m.stage, to, "lead", flowOf(m))) {
        // The mission moved on meanwhile (you stopped it, or the pull request closed): drop the request.
        this.deps.db.update(schema.missions).set({ pendingStage: null }).where(eq(schema.missions.id, m.id)).run();
        return this.emit(m.id);
      }
      if (to === "done") this.deps.db.update(schema.missions).set({ retro: m.stageSummary }).where(eq(schema.missions.id, m.id)).run();
      // A standing decision of the person: this project's bug fixes go ahead without asking each time.
      const auto = to === "awaiting_approval" && m.kind === "bug" && Boolean(this.deps.projects.get(m.projectId).profile?.autoApproveBugs);
      // No approval request (no button in Linear, no ping in Discord) for a plan that approves itself.
      this.post(m.id, "lead", to === "awaiting_approval" && !auto ? "approval" : "stage", m.stageSummary ?? "(no summary)", "agentswarm");
      this.move(this.row(m.id), to, "lead");
      if (auto) {
        audit(this.deps.db, "system", "mission.auto_approve", m.id, { reason: "project setting" });
        this.post(m.id, "system", "text", "Approved automatically: this project lets bug fixes go ahead without asking. The pull request still waits for you.", "agentswarm");
        this.move(this.row(m.id), "building", "person");
      }
    } else if (WORKING.has(m.stage)) {
      const summary = run.report?.summary ?? "";
      this.post(m.id, "lead", "text", `${summary}\n\n(The lead stopped without finishing this stage. Reply to tell it how to go on.)`.trim(), "agentswarm");
      this.emit(m.id);
    } else {
      this.emit(m.id);
    }
  }

  /** stage_done and request_approval: checks, then records where the mission goes when this execution ends. */
  private async finishStage(id: string, summary: string, approval: boolean): Promise<string> {
    const m = this.row(id);
    const next = approval ? (m.stage === "planning" ? "awaiting_approval" : null) : afterStageDone(m.stage, flowOf(m));
    if (!next) throw new TreeError(approval ? "request_approval is only for the planning stage" : `The ${STAGE_LABEL[m.stage].toLowerCase()} stage does not end with stage_done`);
    const root = this.deps.tree.run(m.rootRunId);
    const live = this.deps.tree.descendants(root.id).filter((r) => !TERMINAL.has(r.status));
    if (live.length) throw new TreeError(`Sub-agents are still working (${live.map((r) => r.title).join(", ")}); wait for them first`);
    const found = await this.docsOnBranch(m, root.branch);
    const missing = requiredDocs(m.stage, m.kind).filter((d) => !found.includes(d));
    if (missing.length) throw new TreeError(`Commit and git_push ${missing.map((d) => `${m.docsPath}/${d}`).join(", ")} first`);
    if (m.stage === "verifying" && !root.prUrl) throw new TreeError("Open the pull request first (open_pull_request)");
    this.deps.db.update(schema.missions).set({ pendingStage: next, stageSummary: summary, docs: [...new Set([...m.docs, ...found])], updatedAt: Date.now() }).where(eq(schema.missions.id, id)).run();
    return approval ? "Sent to the person for approval. You are done until they answer." : "Stage finished. agentSwarm starts the next stage.";
  }

  private async docsOnBranch(m: MissionRow, branch: string): Promise<string[]> {
    const project = this.deps.projects.get(m.projectId);
    const found: string[] = [];
    for (const name of DOC_NAMES) {
      const res = await this.deps.git(["cat-file", "-e", `refs/heads/${branch}:${m.docsPath}/${name}`], { cwd: project.mirrorPath });
      if (res.code === 0) found.push(name);
    }
    return found;
  }

  private webOps(run: RunRow, binding: RunBinding): WebToolOps {
    const { web, agents } = this.deps;
    return {
      fetch: async (url, offset) => {
        try {
          return fenced(pageWindow(await web.fetch(url, binding.signal), offset));
        } catch (error) {
          if (error instanceof FetchError) throw new TreeError(error.message);
          throw error;
        }
      },
      search: async (query) => {
        const agent = agents.get(run.agentId);
        const res = await web.search(query, { endpointId: agent.endpointId, modelId: agent.modelId }, binding.signal);
        if (!res) return null;
        binding.addCost(res.costUsd);
        return fenced(res.text);
      },
    };
  }

  // ---- helpers --------------------------------------------------------------------------

  private missionOf(run: RunRow): MissionRow | null {
    if (!run.missionId) return null;
    return this.deps.db.select().from(schema.missions).where(eq(schema.missions.id, run.missionId)).get() ?? null;
  }

  private pickLead(projectId: string, agentId?: string) {
    if (agentId) {
      const agent = this.deps.agents.get(agentId);
      if (agent.projectId !== projectId || agent.ephemeral) throw badRequest("That agent cannot lead missions in this project");
      return agent;
    }
    const standing = this.deps.agents.list(projectId);
    const lead = standing.find((a) => a.name.toLowerCase() === "lead") ?? standing[0];
    if (!lead) throw badRequest("Create an agent for this project first; it leads the missions");
    return this.deps.agents.get(lead.id);
  }

  private post(missionId: string, author: MessageRow["author"], kind: MessageRow["kind"], text: string, source: Source, discordMessageId: string | null = null, now = Date.now()): MissionMessageView {
    const row = this.deps.db.insert(schema.missionMessages).values({ missionId, author, kind, text: text.slice(0, 8000), source, discordMessageId, createdAt: now }).returning().get();
    this.deps.db.update(schema.missions).set({ updatedAt: now }).where(eq(schema.missions.id, missionId)).run();
    const view = messageView(row);
    this.deps.bus.publish({ kind: "mission_message", message: view });
    return view;
  }

  private emit(id: string): void {
    this.deps.bus.publish({ kind: "mission", mission: this.view(id) });
  }

  private toView(m: MissionRow): MissionView {
    const { tree, projects } = this.deps;
    const project = projects.get(m.projectId);
    const root = tree.run(m.rootRunId);
    const ref = root.prState === "merged" ? project.defaultBranch : root.branch;
    // Local projects have no GitHub: their documents open in the dashboard.
    const docUrl = (name: string) => project.kind === "local"
      ? `/api/projects/${project.id}/blob?ref=${encodeURIComponent(root.branch)}&path=${encodeURIComponent(`${m.docsPath}/${name}`)}`
      : `https://github.com/${project.githubRepo}/blob/${ref}/${m.docsPath}/${name}`;
    const link = this.deps.db.select({ key: schema.linearSessions.issueKey, url: schema.linearSessions.issueUrl }).from(schema.linearSessions)
      .where(eq(schema.linearSessions.missionId, m.id)).get();
    const waitingForYou = GATES.has(m.stage)
      || (root.status === "waiting" && (root.waitingFor ?? []).includes(WAIT_FOR_USER))
      || (WORKING.has(m.stage) && TERMINAL.has(root.status) && !m.pendingStage && !this.deps.runs.isActive(root.id));
    return {
      id: m.id, projectId: m.projectId, projectName: project.name, githubRepo: project.githubRepo, title: m.title, intent: m.intent,
      stage: m.stage, fast: m.fast, leadAgentId: m.leadAgentId, rootRunId: m.rootRunId, treeId: m.treeId, branch: root.branch, docsPath: m.docsPath,
      docs: m.docs.map((name) => ({ name, url: docUrl(name) })),
      budgetUsd: root.budgetUsd ?? 0, costUsd: tree.subtreeCost(root), leadStatus: root.status, waitingForYou: waitingForYou && !ENDED.has(m.stage),
      stageSummary: m.stageSummary, prUrl: root.prUrl, prState: root.prState, retro: m.retro, discordThreadId: m.discordThreadId, error: m.error,
      createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
      kind: m.kind, origin: m.origin, linear: link ? { key: link.key, url: link.url } : null,
    };
  }
}

function messageView(r: MessageRow): MissionMessageView {
  return { id: r.id, missionId: r.missionId, author: r.author, kind: r.kind, text: r.text, source: r.source, createdAt: r.createdAt };
}
