import { and, desc, eq } from "drizzle-orm";
import { BRANCH_PATTERN } from "@hive/priv-helper";
import type { GitPush } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { RepoService } from "../repos/repo-service.ts";
import { gitOk, type GitRunner } from "../repos/git-cli.ts";
import type { GitHubPort } from "./github.ts";
import { scanAddedLines } from "./secret-scan.ts";

export const RELAY_LIMITS = { maxCommits: 100, maxFiles: 300, maxChangedLines: 20_000 } as const;

type PushRow = typeof schema.gitPushes.$inferSelect;

export interface RelayDeps {
  readonly db: Db;
  readonly backend: WorkstationBackend;
  readonly repos: RepoService;
  readonly git: GitRunner;
  readonly github: GitHubPort;
  readonly onPush: (push: GitPush) => void;
  /** Task branches may only be pushed by the task's current assignee. */
  readonly taskAssignee?: (taskId: string) => string | null;
  /** A PR was opened (or found) for a worktree; tasks move to review. */
  readonly onPullRequest?: (input: { worktreeId: string; taskId: string | null; agentId: string; url: string }) => void;
}

export interface PushOutcome {
  readonly push: GitPush;
  readonly message: string;
}

/**
 * Holds the GitHub credentials; agents never do. A push travels
 * worktree -> workstation inbox -> hived mirror (checked) -> GitHub.
 */
export class GitRelay {
  constructor(private readonly deps: RelayDeps) {}

  async push(input: { agentId: string; worktreeId: string; osUser: string }): Promise<PushOutcome> {
    const wt = this.deps.repos.worktree(input.worktreeId);
    if (!wt || wt.removedAt || wt.agentId !== input.agentId) return this.reject(input, "", null, "Not your worktree");
    if (!BRANCH_PATTERN.test(wt.branch)) return this.reject(input, wt.branch, null, "Branch name is not a hive/<agent>/<slug> branch");
    if (wt.taskId && this.deps.taskAssignee?.(wt.taskId) !== input.agentId) {
      return this.reject(input, wt.branch, null, "Only the task's current assignee may push its branch");
    }
    const repo = this.deps.db.select().from(schema.repositories).where(eq(schema.repositories.id, wt.repositoryId)).get();
    if (!repo) return this.reject(input, wt.branch, null, "Repository no longer registered");

    const { head, inbox } = await this.deps.backend.call<{ head: string; inbox: string }>(input.osUser, { op: "git.pushInbox", scope: wt.scope, branch: wt.branch });
    const mirror = this.deps.repos.mirrorPath(repo);
    const incoming = `refs/hive-incoming/${wt.branch}`;
    try {
      await this.deps.repos.refresh(repo);
      await gitOk(this.deps.git, ["fetch", "--quiet", "--no-tags", inbox, `+refs/heads/${wt.branch}:${incoming}`], { cwd: mirror });
      const fetched = (await gitOk(this.deps.git, ["rev-parse", incoming], { cwd: mirror })).trim();
      if (fetched !== head) return this.reject(input, wt.branch, head, "Inbox head does not match the worktree head");

      const remote = await this.deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`], { cwd: mirror });
      if (remote.code === 0) {
        const ancestor = await this.deps.git(["merge-base", "--is-ancestor", remote.out.trim(), incoming], { cwd: mirror });
        if (ancestor.code !== 0) return this.reject(input, wt.branch, head, "Push would rewrite published history (force push is not allowed)");
      }
      const base = `refs/heads/${repo.defaultBranch}`;
      const problem = await this.checkLimits(mirror, base, incoming);
      if (problem) return this.reject(input, wt.branch, head, problem);

      await gitOk(this.deps.git, ["push", "--quiet", repo.remoteUrl, `${incoming}:refs/heads/${wt.branch}`], { cwd: mirror, timeoutMs: 300_000 });
      await this.deps.repos.refresh(repo);
    } catch (error) {
      return this.record(input, wt.branch, head, "failed", (error as Error).message.slice(0, 300));
    }
    const outcome = this.record(input, wt.branch, head, "pushed", null);
    return { ...outcome, message: `Pushed ${wt.branch} at ${head.slice(0, 10)}.` };
  }

  async createPullRequest(input: { agentId: string; worktreeId: string; title: string; body: string }): Promise<string> {
    const wt = this.deps.repos.worktree(input.worktreeId);
    if (!wt || wt.agentId !== input.agentId) throw new Error("Not your worktree");
    if (wt.taskId && this.deps.taskAssignee?.(wt.taskId) !== input.agentId) throw new Error("Only the task's current assignee may open its pull request");
    const last = this.deps.db.select().from(schema.gitPushes)
      .where(and(eq(schema.gitPushes.worktreeId, wt.id), eq(schema.gitPushes.status, "pushed")))
      .orderBy(desc(schema.gitPushes.id)).limit(1).get();
    if (!last) throw new Error("Push the branch with git_push before opening a pull request");
    const repo = this.deps.db.select().from(schema.repositories).where(eq(schema.repositories.id, wt.repositoryId)).get();
    if (!repo) throw new Error("Repository no longer registered");
    const body = `${input.body.trim()}\n\n---\nOpened by a Hive agent from \`${wt.branch}\`. Merging is left to a human.`;
    const url = await this.deps.github.createPullRequest({ repo: repo.githubFullName, head: wt.branch, base: repo.defaultBranch, title: input.title, body });
    const row = this.deps.db.update(schema.gitPushes).set({ prUrl: url }).where(eq(schema.gitPushes.id, last.id)).returning().get()!;
    this.deps.onPush(toPush(row));
    this.deps.onPullRequest?.({ worktreeId: wt.id, taskId: wt.taskId, agentId: input.agentId, url });
    return url;
  }

  history(agentId: string, limit = 20): GitPush[] {
    return this.deps.db.select().from(schema.gitPushes).where(eq(schema.gitPushes.agentId, agentId)).orderBy(desc(schema.gitPushes.id)).limit(limit).all().map(toPush);
  }

  private async checkLimits(mirror: string, base: string, incoming: string): Promise<string | null> {
    const commits = Number((await gitOk(this.deps.git, ["rev-list", "--count", `${base}..${incoming}`], { cwd: mirror })).trim());
    if (commits === 0) return "Nothing new to push compared with the default branch";
    if (commits > RELAY_LIMITS.maxCommits) return `Too many commits (${commits} > ${RELAY_LIMITS.maxCommits})`;
    const numstat = await gitOk(this.deps.git, ["diff", "--numstat", `${base}...${incoming}`], { cwd: mirror });
    const rows = numstat.split("\n").filter(Boolean);
    const lines = rows.reduce((sum, r) => {
      const [a, d] = r.split("\t");
      return sum + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
    if (rows.length > RELAY_LIMITS.maxFiles) return `Too many files changed (${rows.length} > ${RELAY_LIMITS.maxFiles})`;
    if (lines > RELAY_LIMITS.maxChangedLines) return `Change too large (${lines} lines > ${RELAY_LIMITS.maxChangedLines})`;
    const diff = await gitOk(this.deps.git, ["diff", "--unified=0", `${base}...${incoming}`], { cwd: mirror });
    const secrets = scanAddedLines(diff);
    if (secrets.length > 0) return `Possible secrets in the diff (${secrets.join(", ")}); remove them and amend before pushing`;
    return null;
  }

  private reject(input: { agentId: string; worktreeId: string }, branch: string, head: string | null, reason: string): PushOutcome {
    const outcome = this.record(input, branch, head, "rejected", reason);
    return { ...outcome, message: `Push rejected: ${reason}` };
  }

  private record(input: { agentId: string; worktreeId: string }, branch: string, head: string | null, status: PushRow["status"], reason: string | null): PushOutcome {
    const row = this.deps.db.insert(schema.gitPushes).values({ worktreeId: input.worktreeId, agentId: input.agentId, branch, headSha: head, status, reason, prUrl: null, createdAt: Date.now() }).returning().get();
    const push = toPush(row);
    this.deps.onPush(push);
    return { push, message: status === "failed" ? `Push failed: ${reason}` : status };
  }
}

function toPush(row: PushRow): GitPush {
  return { id: row.id, worktreeId: row.worktreeId, agentId: row.agentId, branch: row.branch, headSha: row.headSha, status: row.status, reason: row.reason, prUrl: row.prUrl, createdAt: row.createdAt };
}
