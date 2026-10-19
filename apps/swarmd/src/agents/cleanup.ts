import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { GitRunner } from "../github/git.ts";
import type { GitHubService } from "../github/github-service.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { TERMINAL } from "./tree-service.ts";

type RunRow = typeof schema.runs.$inferSelect;
const LIVE: RunRow["status"][] = ["queued", "running", "waiting"];

export interface CleanupDeps {
  readonly db: Db;
  readonly backend: WorkstationBackend;
  readonly projects: ProjectService;
  readonly github: GitHubService;
  readonly git: GitRunner;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** True while a run's execution is still winding down (its processes may still be running). */
  readonly isActive: (runId: string) => boolean;
}

export interface CleanupResult {
  readonly worktrees: number;
  readonly branches: number;
  /** Steps that failed; the tree is marked cleaned only when there are none, so it is tried again. */
  readonly failures: number;
}

/**
 * After a tree's pull request is merged or closed: removes every worktree it left on the workstations
 * and every swarm/… branch it pushed (GitHub and the mirror). Runs, events and sessions stay.
 */
export class TreeCleanup {
  private readonly deps: CleanupDeps;
  private readonly cleaning = new Set<string>();

  constructor(deps: CleanupDeps) {
    this.deps = deps;
  }

  async clean(treeId: string, now = Date.now()): Promise<CleanupResult> {
    const { db, backend, projects, github, git, log } = this.deps;
    const nodes = db.select().from(schema.runs).where(eq(schema.runs.treeId, treeId)).all();
    if (nodes.length === 0) return { worktrees: 0, branches: 0, failures: 0 };
    if (nodes.some((n) => !TERMINAL.has(n.status) || this.deps.isActive(n.id))) throw new Error(`Tree ${treeId} still has unfinished runs`);
    if (this.cleaning.has(treeId)) return { worktrees: 0, branches: 0, failures: 0 };
    this.cleaning.add(treeId);
    try {
      const project = projects.get(nodes[0]!.projectId);
      let worktrees = 0;
      let failures = 0;
      for (const n of nodes) {
        if (!n.workstationId) continue;
        try {
          const res = await backend.call<{ removed: boolean }>(n.workstationId, { op: "git.remove", scope: n.worktreeScope }, { timeoutMs: 120_000 });
          if (res.removed) worktrees++;
        } catch (error) {
          failures++;
          log("worktree cleanup failed", { runId: n.id, ws: n.workstationId, error: (error as Error).message });
        }
      }
      const prefix = `swarm/${project.slug}/${treeId}/`;
      const branches = [...new Set(nodes.filter((n) => n.kind === "task" && n.branch.startsWith(prefix)).map((n) => n.branch))];
      const token = await projects.tokenFor(project);
      let deleted = 0;
      for (const branch of branches) {
        try {
          if (token) {
            if (await github.client.deleteBranch(token, project.githubRepo, branch)) deleted++;
          } else {
            // A local remote (tests): delete it there directly.
            const res = await git(["push", "--quiet", project.remoteUrl, "--delete", branch], { cwd: project.mirrorPath });
            if (res.code === 0) deleted++;
            else if (!/remote ref does not exist/.test(res.err)) failures++;
          }
        } catch (error) {
          failures++;
          log("branch cleanup failed", { branch, error: (error as Error).message });
        }
        for (const ref of [`refs/heads/${branch}`, `refs/swarm-incoming/${branch}`]) await git(["update-ref", "-d", ref], { cwd: project.mirrorPath });
      }
      if (failures === 0) db.update(schema.runs).set({ cleanedAt: now }).where(eq(schema.runs.treeId, treeId)).run();
      log(failures ? "tree cleanup incomplete; will retry" : "tree cleaned up", { treeId, worktrees, branches: deleted, failures });
      return { worktrees, branches: deleted, failures };
    } finally {
      this.cleaning.delete(treeId);
    }
  }

  /** Cleans once every run of the tree has ended (a cancel takes a moment to wind down). */
  async cleanWhenSettled(treeId: string, timeoutMs = 120_000): Promise<CleanupResult | null> {
    const end = Date.now() + timeoutMs;
    while (this.live(treeId) > 0 || this.deps.db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.treeId, treeId)).all().some((r) => this.deps.isActive(r.id))) {
      if (Date.now() > end) {
        this.deps.log("cleanup skipped: runs did not finish", { treeId });
        return null;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.clean(treeId);
  }

  private live(treeId: string): number {
    return this.deps.db.select({ id: schema.runs.id }).from(schema.runs).where(and(eq(schema.runs.treeId, treeId), inArray(schema.runs.status, LIVE))).all().length;
  }
}
