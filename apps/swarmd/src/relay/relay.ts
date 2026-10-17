import { desc, eq } from "drizzle-orm";
import { BRANCH_PATTERN, type Layout } from "@agentswarm/ws-exec";
import type { PushView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { ProjectService } from "../projects/project-service.ts";
import { gitOk, type GitRunner } from "../github/git.ts";
import type { EventBus } from "../events/event-bus.ts";
import { scanAddedLines } from "./secret-scan.ts";

export const RELAY_LIMITS = { maxCommits: 100, maxFiles: 300, maxChangedLines: 20_000, maxNewBytes: 50 * 1024 * 1024 } as const;
/** Paths an agent may not change: CI workflows run with the repository's secrets. */
const FORBIDDEN_PATHS = /^\.github\//;

type RunRow = typeof schema.runs.$inferSelect;

export interface RelayDeps {
  readonly db: Db;
  readonly backend: WorkstationBackend;
  readonly projects: ProjectService;
  readonly git: GitRunner;
  readonly bus: EventBus;
  readonly layout: Pick<Layout, "inbox">;
}

export interface PushOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The only way code leaves a workstation, and the only holder of the GitHub token:
 * worktree -> the workstation's inbox -> checked in swarmd's mirror -> GitHub.
 */
export class Relay {
  private readonly deps: RelayDeps;

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  async push(run: RunRow, signal?: AbortSignal): Promise<PushOutcome> {
    const { backend, projects, git } = this.deps;
    if (!run.workstationId) return this.reject(run, null, "The run has no workstation");
    if (run.kind === "review") return this.reject(run, null, "Reviewers do not push");
    const project = projects.get(run.projectId);
    if (!BRANCH_PATTERN.test(run.branch) || !run.branch.startsWith(`swarm/${project.slug}/`)) return this.reject(run, null, `Branch ${run.branch} is not a swarm/${project.slug}/… branch`);
    if (run.branch === project.defaultBranch) return this.reject(run, null, "Pushing the default branch is not allowed");

    let head: string;
    try {
      head = (await backend.call<{ head: string }>(run.workstationId, { op: "git.pushInbox", scope: run.worktreeScope, branch: run.branch }, signal ? { signal } : {})).head;
    } catch (error) {
      return this.record(run, null, "failed", `Could not push to the inbox: ${(error as Error).message}`);
    }
    const mirror = project.mirrorPath;
    const inbox = `${this.deps.layout.inbox}/${run.workstationId}.git`;
    const incoming = `refs/swarm-incoming/${run.branch}`;
    try {
      await gitOk(git, ["fetch", "--quiet", "--no-tags", inbox, `+refs/heads/${run.branch}:${incoming}`], { cwd: mirror });
      const fetched = (await gitOk(git, ["rev-parse", incoming], { cwd: mirror })).trim();
      if (fetched !== head) return this.reject(run, head, "The inbox head does not match the worktree head");
      const published = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`], { cwd: mirror });
      if (published.code === 0) {
        const ancestor = await git(["merge-base", "--is-ancestor", published.out.trim(), incoming], { cwd: mirror });
        if (ancestor.code !== 0) return this.reject(run, head, "The push would rewrite published history (force pushes are not allowed)");
      }
      // New work is measured against what this branch was cut from (its parent's branch in a tree).
      const base = run.baseBranch && (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${run.baseBranch}`], { cwd: mirror })).code === 0
        ? run.baseBranch : project.defaultBranch;
      const problem = await this.checkContent(mirror, `refs/heads/${base}`, incoming, projects.protectedPaths(project.id));
      if (problem) return this.reject(run, head, problem);
      // Local projects (sandbox, ideas) end here: the mirror is the only copy.
      if (project.kind !== "local") {
        await gitOk(git, ["push", "--quiet", project.remoteUrl, `${incoming}:refs/heads/${run.branch}`], { cwd: mirror, timeoutMs: 300_000, ...withToken(await projects.tokenFor(project)) });
      }
      await gitOk(git, ["update-ref", `refs/heads/${run.branch}`, head], { cwd: mirror });
    } catch (error) {
      return this.record(run, head, "failed", (error as Error).message.slice(0, 400));
    }
    this.record(run, head, "pushed", null);
    return { ok: true, message: `Pushed ${run.branch} at ${head.slice(0, 10)}.` };
  }

  history(projectId: string, limit = 50): PushView[] {
    return this.deps.db.select().from(schema.gitPushes).where(eq(schema.gitPushes.projectId, projectId)).orderBy(desc(schema.gitPushes.id)).limit(limit).all().map(view);
  }

  private async checkContent(mirror: string, base: string, incoming: string, protectedPaths: readonly string[] = []): Promise<string | null> {
    const { git } = this.deps;
    const commits = Number((await gitOk(git, ["rev-list", "--count", `${base}..${incoming}`], { cwd: mirror })).trim());
    if (commits === 0) return "Nothing new to push compared with the default branch; commit first";
    if (commits > RELAY_LIMITS.maxCommits) return `Too many commits (${commits} > ${RELAY_LIMITS.maxCommits})`;
    const rows = (await gitOk(git, ["diff", "--numstat", `${base}...${incoming}`], { cwd: mirror })).split("\n").filter(Boolean);
    const lines = rows.reduce((sum, r) => {
      const [a, d] = r.split("\t");
      return sum + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
    if (rows.length > RELAY_LIMITS.maxFiles) return `Too many files changed (${rows.length} > ${RELAY_LIMITS.maxFiles})`;
    if (lines > RELAY_LIMITS.maxChangedLines) return `Change too large (${lines} lines > ${RELAY_LIMITS.maxChangedLines})`;
    const forbidden = rows.map((r) => r.split("\t")[2] ?? "").filter((path) => FORBIDDEN_PATHS.test(path));
    if (forbidden.length) return `Changes under .github/ are not allowed (${forbidden.slice(0, 3).join(", ")})`;
    // The project's local files (secrets, local config) never leave this Mac, in any commit.
    if (protectedPaths.length) {
      const touched = (await gitOk(git, ["log", "--format=", "--name-only", `${base}..${incoming}`], { cwd: mirror })).split("\n").filter(Boolean);
      const hit = [...new Set(touched.filter((p) => protectedPaths.includes(p)))];
      if (hit.length) return `The project's local files must not be committed (${hit.slice(0, 3).join(", ")}); remove them from every commit (rewrite the branch) before pushing`;
    }
    // Binary files count as 0 lines above; cap what the push would actually upload.
    const bytes = Number((await gitOk(git, ["rev-list", "--objects", "--disk-usage", `${base}..${incoming}`], { cwd: mirror })).trim());
    if (bytes > RELAY_LIMITS.maxNewBytes) return `Push too large (${Math.round(bytes / 1024 / 1024)} MB of new objects > ${RELAY_LIMITS.maxNewBytes / 1024 / 1024} MB)`;
    // Every commit is published, so scan each one (a secret added then deleted is still in history), messages included.
    const history = await gitOk(git, ["log", "-p", "--no-merges", "--unified=0", "--format=%x00%B", `${base}..${incoming}`], { cwd: mirror });
    const secrets = scanAddedLines(history, { includeUnprefixed: true });
    if (secrets.length > 0) return `Possible secrets in the commits (${secrets.join(", ")}); remove them from every commit (rewrite the branch) before pushing`;
    return null;
  }

  private reject(run: RunRow, head: string | null, reason: string): PushOutcome {
    return this.record(run, head, "rejected", reason);
  }

  private record(run: RunRow, head: string | null, status: "pushed" | "rejected" | "failed", reason: string | null, now = Date.now()): PushOutcome {
    const row = this.deps.db.insert(schema.gitPushes).values({ runId: run.id, projectId: run.projectId, branch: run.branch, headSha: head, status, reason, createdAt: now }).returning().get();
    this.deps.bus.runEvent(run.id, "push", { ...view(row) }, now);
    return { ok: status === "pushed", message: status === "pushed" ? "pushed" : `Push ${status}: ${reason}` };
  }
}

function withToken(token: string | undefined): { token?: string } {
  return token ? { token } : {};
}

function view(row: typeof schema.gitPushes.$inferSelect): PushView {
  return { id: row.id, runId: row.runId, branch: row.branch, headSha: row.headSha, status: row.status, reason: row.reason, createdAt: row.createdAt };
}

