import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { parsePullRequestUrl, type PullRequestState } from "./github-client.ts";
import type { GitHubService } from "./github-service.ts";

type RunRow = typeof schema.runs.$inferSelect;

export const PR_POLL_MS = 2 * 60_000;

export interface WatcherDeps {
  readonly db: Db;
  readonly github: GitHubService;
  /** Called on every poll for a pull request that is merged or closed (idempotent), and when one changes. */
  readonly settle: (root: RunRow, state: PullRequestState) => Promise<void>;
  /** Runs on every poll, for cleanups that do not depend on a pull request. */
  readonly sweep?: () => Promise<void>;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  readonly intervalMs?: number;
}

/** Polls the pull requests agentSwarm opened (no webhooks: swarmd has no public address). */
export class PullRequestWatcher {
  private readonly deps: WatcherDeps;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.deps.intervalMs ?? PR_POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { db, github, log } = this.deps;
      await this.deps.sweep?.().catch((error: Error) => log("cleanup sweep failed", { error: error.message }));
      const roots = db.select().from(schema.runs)
        .where(and(isNotNull(schema.runs.prUrl), isNull(schema.runs.cleanedAt), isNull(schema.runs.parentRunId))).all();
      if (roots.length === 0 || !github.status().configured) return;
      const token = await github.token();
      for (const root of roots) {
        let state = root.prState;
        if (state === null || state === "open") {
          const pr = parsePullRequestUrl(root.prUrl!);
          if (!pr) continue;
          try {
            state = await github.client.pullRequestState(token, pr.repo, pr.number);
          } catch (error) {
            log("pull request check failed", { url: root.prUrl, error: (error as Error).message });
            continue;
          }
          if (state !== root.prState) db.update(schema.runs).set({ prState: state }).where(eq(schema.runs.id, root.id)).run();
        }
        if (state === "open") continue;
        await this.deps.settle({ ...root, prState: state }, state).catch((error: Error) => log("pull request follow-up failed", { url: root.prUrl, error: error.message }));
      }
    } catch (error) {
      this.deps.log("pull request poll failed", { error: (error as Error).message });
    } finally {
      this.polling = false;
    }
  }
}
