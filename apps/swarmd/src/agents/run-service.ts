import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { CreateRun, MachineLoadView, RunEventView, RunReport, RunView, TreeView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { RunLimits } from "../db/schema.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { conflict, notFound } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { WorkstationPool } from "../workstations/pool.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { ModelGateway } from "../models/model-gateway.ts";
import type { Relay } from "../relay/relay.ts";
import type { AgentService } from "./agent-service.ts";
import { REVIEW_TOOL_NAMES, workstationTools } from "./tools.ts";
import { Eyes } from "../eyes/eyes.ts";
import { keepRecentImages } from "../eyes/images.ts";
import { projectLines, reviewerPrompt, systemPrompt } from "./prompts.ts";
import { TERMINAL, TREE_LIMITS, TreeError, type TreeService } from "./tree-service.ts";
import { treeTools, verdictTool, type TreeToolOps } from "./tree-tools.ts";
import type { CliRuntimeName } from "@agentswarm/contracts";
import type { CliService } from "../cli/cli-service.ts";
import { CliRunner, type CliExecution } from "../cli/cli-run.ts";
import { CLI_DEFAULT_MODEL } from "../cli/cli-prompts.ts";
import type { AgentRow } from "./agent-service.ts";
import type { ProjectRow } from "../projects/project-service.ts";

export type RunRow = typeof schema.runs.$inferSelect;

/** In waitingFor: the run waits for the person's answer (ask_user), not for other runs. */
export const WAIT_FOR_USER = "@user";

/** What one execution of a run lets an extension do. */
export interface RunBinding {
  readonly signal: AbortSignal;
  /** End this execution after the current turn and wait for the person's next message. */
  waitForUser(): void;
  /** Charges something other than model tokens (a web search) to the run. */
  addCost(usd: number): void;
}

/** Missions extend runs through these; RunService knows nothing else about them. */
export interface RunHooks {
  /** Tools to add, and which standard tools to keep (default: all). */
  tools(run: RunRow, binding: RunBinding): { add: AgentTool<any, undefined>[]; keep?: (name: string) => boolean } | null;
  /** Prompt additions for this run: a section to append, and what replaces "finish with report". */
  prompt(run: RunRow): { section: string[]; finish: string } | null;
  /** An execution ended: the run finished, failed, was cancelled, or is waiting. */
  ended(run: RunRow): void;
  /** The pull request a root opens: what the extension adds (a Linear ticket key, "Fixes ZAC-42"). */
  pullRequest?(run: RunRow, title: string, body: string): { title: string; body: string };
}

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 80, maxDurationMs: 30 * 60_000, maxCostUsd: 1 };
/** A mission lead runs a whole stage per execution (spawning, waiting, reviewing, merging): more turns. */
export const MISSION_LEAD_TURNS = 150;
/** A failed model request is retried this many times before the run fails. */
export const MODEL_RETRIES = 2;
const QUOTA_RETRY_MS = 5 * 60_000;
const MEMORY_RETRY_MS = 20_000;

const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
});

export interface RunDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly pool: WorkstationPool;
  readonly backend: WorkstationBackend;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly gateway: ModelGateway;
  readonly relay: Relay;
  readonly tree: TreeService;
  readonly cli: CliService;
  readonly maxConcurrent: number;
  /** R6: runs with a simulator or a browser at once (Xcode builds, simulators and Chromium are heavy). */
  readonly heavySlots: number;
  /** R6: the kernel's memory pressure level (1 normal, 2 warning, 4 critical); new heavy runs wait above 1. */
  readonly memoryPressure: () => number;
  /** R6: where each run's screenshots are kept for the dashboard (<dir>/<runId>/NNN.jpg). */
  readonly screensDir: string;
  readonly limits?: RunLimits;
  /** Fetch GitHub into the mirror before a run clones it (off in tests with local remotes). */
  readonly refreshMirror: boolean;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** "shutdown": swarmd is stopping; the run is interrupted like a crash, not cancelled by anyone. */
type StopReason = "cancelled" | "shutdown" | "turns" | "time" | "cost";
const RESTART_TEXT = "Interrupted by an agentSwarm restart; send a message to continue";

interface Active {
  readonly controller: AbortController;
  agent: Agent | null;
  reason: StopReason | null;
  done: Promise<void>;
  /** Messages that arrived while the agent was not taking input (starting up, or just finishing). */
  readonly inbox: string[];
  /** Set by wait_agents or review_agent: suspend when this execution ends, until these runs finish. */
  waitFor: string[] | null;
  /** R6: the run's simulator and browser, closed when the execution ends. */
  eyes: Eyes | null;
}

const STOP_TEXT: Record<Exclude<StopReason, "cancelled">, string> = {
  shutdown: RESTART_TEXT,
  turns: "Stopped: the run reached its turn limit",
  time: "Stopped: the run reached its time limit",
  cost: "Stopped: the run reached its cost limit",
};

export class RunService {
  private readonly deps: RunDeps;
  private readonly active = new Map<string, Active>();
  private scheduling = false;
  private rescheduled = false;
  private hooks: RunHooks | null = null;
  private readonly cliRunner: CliRunner;
  private retryTimer: NodeJS.Timeout | null = null;
  private memoryTimer: NodeJS.Timeout | null = null;

  constructor(deps: RunDeps) {
    this.deps = deps;
    this.cliRunner = new CliRunner({ backend: deps.backend, relay: deps.relay, cli: deps.cli, getRun: (id) => this.get(id) });
  }

  attach(hooks: RunHooks): void {
    this.hooks = hooks;
  }

  // ---- queries --------------------------------------------------------------------------

  list(filter: { agentId?: string; projectId?: string } = {}, limit = 50): RunView[] {
    const where = filter.agentId ? eq(schema.runs.agentId, filter.agentId) : filter.projectId ? eq(schema.runs.projectId, filter.projectId) : undefined;
    return this.deps.db.select().from(schema.runs).where(where).orderBy(desc(schema.runs.createdAt)).limit(Math.min(limit, 200)).all().map((r) => this.toView(r));
  }

  get(id: string): RunRow {
    const row = this.deps.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    if (!row) throw notFound("No such run");
    return row;
  }

  /** True while an execution holds the run (including the moment after it ends, before its workstation is released). */
  isActive(id: string): boolean {
    return this.active.has(id);
  }

  view(id: string): RunView {
    return this.toView(this.get(id));
  }

  tree(treeId: string): TreeView {
    const nodes = this.deps.db.select().from(schema.runs).where(eq(schema.runs.treeId, treeId)).orderBy(asc(schema.runs.createdAt)).limit(500).all();
    if (nodes.length === 0) throw notFound("No such tree");
    return { treeId, nodes: nodes.map((r) => this.toView(r)), totalCostUsd: nodes.reduce((sum, r) => sum + r.costUsd, 0) };
  }

  /**
   * The latest events of a whole tree, oldest first (before: page further back), for one live view of
   * everything its agents do.
   */
  treeEvents(treeId: string, before: number | null = null, limit = 400): RunEventView[] {
    const ids = this.deps.db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.treeId, treeId)).all().map((r) => r.id);
    if (!ids.length) throw notFound("No such tree");
    return this.deps.db.select().from(schema.runEvents)
      .where(and(inArray(schema.runEvents.runId, ids), before ? lt(schema.runEvents.id, before) : undefined))
      .orderBy(desc(schema.runEvents.id)).limit(Math.min(limit, 1000)).all().reverse()
      .map((r) => ({ id: r.id, runId: r.runId, type: r.type as RunEventView["type"], data: r.data, createdAt: r.createdAt }));
  }

  events(runId: string, after = 0, limit = 500): RunEventView[] {
    this.get(runId);
    return this.deps.db.select().from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.id, after)))
      .orderBy(asc(schema.runEvents.id)).limit(Math.min(limit, 1000)).all()
      .map((r) => ({ id: r.id, runId: r.runId, type: r.type as RunEventView["type"], data: r.data, createdAt: r.createdAt }));
  }

  // ---- commands -------------------------------------------------------------------------

  private limitsFor(missionId: string | null): RunLimits {
    const limits = this.deps.limits ?? DEFAULT_LIMITS;
    return missionId ? { ...limits, maxTurns: Math.max(limits.maxTurns, MISSION_LEAD_TURNS) } : limits;
  }

  create(actor: string, agentId: string, input: CreateRun, now = Date.now(), missionId: string | null = null): RunView {
    const agent = this.deps.agents.get(agentId);
    const project = this.deps.projects.get(agent.projectId);
    const names = this.deps.tree.rootNames(project, input.title);
    const row: RunRow = {
      id: newId("run"), agentId, projectId: project.id, title: input.title.trim(), brief: input.brief,
      branch: names.branch, worktreeScope: names.scope, workstationId: null,
      status: "queued", pendingMessage: input.brief, report: null, error: null, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
      limits: this.limitsFor(missionId), createdAt: now, startedAt: null, endedAt: null,
      treeId: names.treeId, parentRunId: null, depth: 0, baseBranch: null, budgetUsd: input.budgetUsd ?? TREE_LIMITS.defaultRootBudgetUsd,
      kind: "task", reviewOf: null, review: null, mergedAt: null, prUrl: null, waitingFor: null, reviewSha: null,
      missionId, prState: null, cleanedAt: null, cliSession: null, estimatedUsd: 0, needs: null,
    };
    this.deps.db.insert(schema.runs).values(row).run();
    audit(this.deps.db, actor, "run.create", row.id, { agentId, branch: row.branch }, now);
    this.deps.bus.runEvent(row.id, "user", { text: input.brief }, now);
    this.emit(row.id);
    this.schedule();
    return this.toView(row);
  }

  /** While running, steers the agent; afterwards, queues a follow-up on the same worktree. */
  message(actor: string, runId: string, text: string, now = Date.now(), from: "person" | "agentswarm" = "person"): RunView {
    const run = this.get(runId);
    if (run.cleanedAt) throw conflict("This run's worktree was removed after its pull request closed; start a new run");
    this.deps.bus.runEvent(runId, "user", { text, ...(from === "agentswarm" ? { from } : {}) }, now);
    const active = this.active.get(runId);
    if (active?.agent?.state.isStreaming) {
      active.agent.steer({ role: "user", content: text, timestamp: now });
    } else if (active && run.status === "running") {
      active.inbox.push(text);
    } else if (active) {
      // The execution has ended and is releasing its workstation: keep the message in the database,
      // so a restart in this moment cannot lose it; the release delivers it.
      this.appendPending(runId, text);
    } else if (run.status === "waiting" && run.waitingFor?.includes(WAIT_FOR_USER)) {
      this.answer(runId, text);
    } else if (run.status === "waiting" || run.status === "queued") {
      // Delivered when it runs next (for a waiting run: with its children's results).
      this.appendPending(runId, text);
    } else {
      // New work on a finished task: its old review and merge no longer describe what it will push.
      this.deps.db.update(schema.runs).set({ status: "queued", pendingMessage: text, error: null, endedAt: null, waitingFor: null, ...(run.kind === "task" ? { review: null, mergedAt: null } : {}) })
        .where(eq(schema.runs.id, runId)).run();
      this.emit(runId);
      this.schedule();
    }
    audit(this.deps.db, actor, "run.message", runId, {}, now);
    return this.view(runId);
  }

  /** Cancels the run and everything it spawned. */
  cancel(actor: string, runId: string, now = Date.now()): RunView {
    const run = this.get(runId);
    const live = [run, ...this.deps.tree.descendants(runId)].filter((r) => !TERMINAL.has(r.status));
    if (live.length === 0) throw conflict(`The run is already ${run.status}`);
    this.cancelTree(runId, now);
    audit(this.deps.db, actor, "run.cancel", runId, { runs: live.length }, now);
    this.schedule();
    return this.view(runId);
  }

  private cancelTree(runId: string, now = Date.now()): void {
    // Children first, so a parent is never resumed by its own children's cancellation.
    for (const r of [...this.deps.tree.descendants(runId).reverse(), this.get(runId)]) {
      if (TERMINAL.has(r.status)) continue;
      const active = this.active.get(r.id);
      if (active && r.status === "running") {
        active.reason = "cancelled";
        active.controller.abort();
        active.agent?.abort();
        if (r.workstationId) void this.deps.pool.reap(r.workstationId).catch(() => undefined);
      } else {
        // Not executing, or its execution already ended (waiting) and is only releasing its workstation.
        if (active) active.reason = "cancelled";
        this.finish(r.id, "cancelled", r.report, null, now);
      }
    }
  }

  /** After a restart nothing is running: interrupted runs become failed and can be resumed with a message. */
  recover(now = Date.now()): void {
    const stale = this.deps.db.select().from(schema.runs).where(eq(schema.runs.status, "running")).all();
    for (const run of stale) this.finish(run.id, "failed", null, RESTART_TEXT, now);
    // Messages that were stored for a run as its execution ended, but not yet delivered.
    for (const run of this.deps.db.select().from(schema.runs).where(isNotNull(schema.runs.pendingMessage)).all()) this.deliverPending(run.id);
    const trees = new Set(this.deps.db.select({ t: schema.runs.treeId }).from(schema.runs).where(eq(schema.runs.status, "waiting")).all().map((r) => r.t));
    for (const t of trees) this.resumeWaiters(t);
    this.schedule();
  }

  /** Cancels everything running and waits for it to wind down (shutdown and tests). */
  async stopAll(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.memoryTimer) clearTimeout(this.memoryTimer);
    this.retryTimer = null;
    for (const [id, active] of this.active) {
      active.reason = "shutdown";
      active.controller.abort();
      active.agent?.abort();
      this.deps.log("run cancelled for shutdown", { runId: id });
    }
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** Resolves when the run has finished for good (tests and scripts); a waiting run is not finished. */
  async settled(runId: string, timeoutMs = 120_000): Promise<RunView> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await this.active.get(runId)?.done;
      const v = this.view(runId);
      if (TERMINAL.has(v.status)) return v;
      if (Date.now() > end) throw new Error(`run ${runId} still ${v.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---- scheduling -----------------------------------------------------------------------

  schedule(): void {
    // Re-entrant calls (a run failed or resumed while scheduling) ask for one more pass.
    if (this.scheduling) {
      this.rescheduled = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduled = false;
        this.schedulePass();
      } while (this.rescheduled);
    } finally {
      this.scheduling = false;
    }
  }

  private schedulePass(): void {
    {
      const queued = this.deps.db.select().from(schema.runs).where(eq(schema.runs.status, "queued")).orderBy(asc(schema.runs.createdAt)).all();
      const workstations = new Map(this.deps.pool.list().map((w) => [w.id, w.status]));
      // CLI runs share your subscription: at most maxConcurrent of each at once; the rest wait their turn.
      const cliRunning = new Map<string, number>();
      for (const id of this.active.keys()) {
        const runtime = this.runtimeOf(this.get(id));
        if (runtime !== "native") cliRunning.set(runtime, (cliRunning.get(runtime) ?? 0) + 1);
      }
      const codexReady = new Set(this.deps.pool.codexReady());
      // Simulators and browsers: a few at once, and none started while memory is already tight.
      let heavy = [...this.active.keys()].filter((id) => this.get(id).needs?.length).length;
      let pressure: number | null = null;
      for (const run of queued) {
        if (this.active.size >= this.deps.maxConcurrent) break;
        if (run.needs?.length) {
          if (heavy >= this.deps.heavySlots) continue;
          pressure ??= this.deps.memoryPressure();
          if (pressure > 1) {
            this.retryOnMemory();
            continue;
          }
        }
        // A follow-up needs the workstation that holds its worktree.
        if (run.workstationId && (workstations.get(run.workstationId) ?? "unhealthy") === "unhealthy") {
          this.finish(run.id, "failed", run.report, `Its workstation ${run.workstationId} is unavailable; start a new run`);
          continue;
        }
        const runtime = this.runtimeOf(run);
        if (runtime !== "native") {
          const available = this.deps.cli.availability(runtime);
          if (!available.ok && available.blocked === "quota") {
            // It waits for the window to reset rather than failing.
            this.retryLater();
            continue;
          }
          if (!available.ok) {
            this.finish(run.id, "failed", run.report, available.reason);
            continue;
          }
          if ((cliRunning.get(runtime) ?? 0) >= this.deps.cli.maxConcurrent()) continue;
        }
        if (runtime === "codex" && run.workstationId && !codexReady.has(run.workstationId)) {
          this.finish(run.id, "failed", run.report, `Codex is no longer signed in on ${run.workstationId}; sign it in again or start a new run`);
          continue;
        }
        const ws = this.deps.pool.acquire(run.id, run.workstationId, Date.now(), runtime === "codex" ? (w) => codexReady.has(w.id) : undefined);
        if (!ws) continue;
        if (runtime !== "native") cliRunning.set(runtime, (cliRunning.get(runtime) ?? 0) + 1);
        if (run.needs?.length) heavy += 1;
        this.start(run, ws);
      }
    }
  }

  private start(run: RunRow, ws: string, now = Date.now()): void {
    const active: Active = { controller: new AbortController(), agent: null, reason: null, done: Promise.resolve(), inbox: [], waitFor: null, eyes: null };
    this.active.set(run.id, active);
    this.deps.db.update(schema.runs).set({ status: "running", workstationId: ws, startedAt: run.startedAt ?? now, error: null, endedAt: null, waitingFor: null }).where(eq(schema.runs.id, run.id)).run();
    this.deps.bus.runEvent(run.id, "status", { status: "running", workstation: ws }, now);
    this.emit(run.id);
    active.done = this.execute(run.id, ws, active)
      .catch((error: Error) => {
        if (active.reason === "cancelled") return this.finish(run.id, "cancelled", null, null);
        if (active.reason === "shutdown") return this.finish(run.id, "failed", null, RESTART_TEXT);
        this.deps.log("run failed", { runId: run.id, error: error.message });
        this.finish(run.id, "failed", null, error.message.slice(0, 500));
      })
      .finally(async () => {
        // The simulator is shut down and erased and the browser closed before everything else is reaped.
        await active.eyes?.close().catch((e: Error) => this.deps.log("closing the simulator or browser failed", { runId: run.id, error: e.message }));
        // Whatever the agent left running (servers, setsid loops) dies with the run.
        await this.deps.pool.reap(ws).catch((e: Error) => this.deps.log("reap failed", { ws, error: e.message }));
        this.deps.pool.release(ws, run.id);
        this.active.delete(run.id);
        // A message that arrived as the run ended: a waiting or resumed run gets it with its next
        // message; a finished one starts a follow-up.
        if (active.reason !== "cancelled" && active.reason !== "shutdown") {
          if (active.inbox.length) this.appendPending(run.id, active.inbox.splice(0).join("\n\n"));
          this.deliverPending(run.id);
        }
        this.schedule();
      });
  }

  // ---- execution ------------------------------------------------------------------------

  private async execute(runId: string, ws: string, active: Active): Promise<void> {
    const { db, bus, backend, projects, agents, gateway, relay } = this.deps;
    const run = this.get(runId);
    const agentRow = agents.get(run.agentId);
    const project = projects.get(run.projectId);
    const signal = active.controller.signal;
    const message = run.pendingMessage ?? "Continue.";
    db.update(schema.runs).set({ pendingMessage: null }).where(eq(schema.runs.id, runId)).run();
    if (agentRow.runtime !== "native") return this.executeCli(run, agentRow, project, ws, active, message);

    // Resolve the model first: a bad model id should not leave a half-prepared worktree behind.
    const { model, streamFn } = await gateway.resolve(agentRow.endpointId, agentRow.modelId);
    const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.runId, runId)).get();
    if (!session) {
      if (this.deps.refreshMirror) {
        await projects.refresh(project.id).catch((e: Error) => bus.runEvent(runId, "error", { message: `Could not refresh from GitHub, using the last mirror: ${e.message}` }));
      }
      const base = run.baseBranch ?? project.defaultBranch;
      await backend.call(ws, { op: "git.clone", scope: run.worktreeScope, mirror: basename(project.mirrorPath), branch: run.branch, base, files: await projects.files(project.id) }, { signal });
      bus.runEvent(runId, "status", { status: "worktree", branch: run.branch, base });
    }

    const counters = { turns: run.turns, tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd };
    let report: RunReport | null = null;
    let verdict = false;
    const wsTools = workstationTools({
      backend, workstation: ws, scope: run.worktreeScope,
      push: (s) => relay.push(this.get(runId), s),
      report: (r) => (report = r),
    });
    const isReview = run.kind === "review";
    const canSpawn = !isReview && run.depth < TREE_LIMITS.maxDepth;
    const tools = isReview
      ? [...wsTools.filter((t) => REVIEW_TOOL_NAMES.has(t.name)), verdictTool((approved, comments) => {
        this.deps.tree.recordVerdict(this.get(runId), approved, comments);
        verdict = true;
        report = { summary: `${approved ? "Approved" : "Changes requested"}: ${comments}`, tests: "", unfinished: [] };
      })]
      : [...wsTools, ...treeTools(this.treeOps(runId, active), { canSpawn, isRoot: run.depth === 0 })];
    if (!isReview && run.needs?.length) {
      active.eyes = new Eyes({ backend, workstation: ws, scope: run.worktreeScope, needs: run.needs, profile: project.profile, screensDir: join(this.deps.screensDir, runId) });
      tools.push(...(active.eyes.tools() as AgentTool<any, undefined>[]));
    }
    const extension = isReview ? null : this.hooks?.tools(run, {
      signal,
      waitForUser: () => (active.waitFor = [...(active.waitFor ?? []), WAIT_FOR_USER]),
      addCost: (usd) => {
        counters.costUsd += usd;
        db.update(schema.runs).set({ costUsd: counters.costUsd }).where(eq(schema.runs.id, runId)).run();
        this.emit(runId);
      },
    });
    if (extension) tools.splice(0, tools.length, ...tools.filter((t) => extension.keep?.(t.name) ?? true), ...extension.add);
    const missionPrompt = isReview ? null : this.hooks?.prompt(run) ?? null;
    const prompt = isReview
      ? reviewerPrompt({ name: agentRow.name, repo: project.githubRepo, branch: run.branch, project: projectLines(project.profile) })
      : systemPrompt({
        name: agentRow.name, role: agentRow.role, instructions: agentRow.instructions, repo: project.githubRepo, defaultBranch: project.defaultBranch, branch: run.branch,
        project: projectLines(project.profile),
        tree: { canSpawn, isRoot: run.depth === 0, depth: run.depth },
        eyes: run.needs ?? [],
        ...(missionPrompt ? { extra: missionPrompt.section, finish: missionPrompt.finish } : {}),
      });
    const agent = new Agent({
      initialState: {
        systemPrompt: prompt,
        model,
        tools,
        messages: (session?.messages ?? []) as AgentMessage[],
      },
      // Only the newest screenshots go to the model (R6).
      transformContext: async (messages) => keepRecentImages(messages),
      streamFn,
      sessionId: runId,
    });
    active.agent = agent;
    signal.addEventListener("abort", () => agent.abort(), { once: true });
    if (signal.aborted) agent.abort();

    const base = { turns: run.turns, costUsd: run.costUsd };
    const stop = (reason: StopReason) => {
      active.reason ??= reason;
      agent.abort();
      active.controller.abort();
    };
    // Limits apply per execution (the first start or a follow-up), not to the run's whole lifetime.
    const deadline = setTimeout(() => stop("time"), run.limits.maxDurationMs);
    agent.subscribe((event) => this.onEvent(runId, event, counters, base, run.limits, stop, agent));

    let lastError: string | null = null;
    try {
      let next: string | undefined = [message, ...active.inbox.splice(0)].join("\n\n");
      while (next !== undefined && !active.reason) {
        await agent.prompt(next);
        lastError = modelError(agent);
        for (let retry = 1; lastError && !active.reason && retry <= MODEL_RETRIES; retry++) {
          bus.runEvent(runId, "error", { message: `Model request failed (${lastError}); retry ${retry} of ${MODEL_RETRIES}` });
          await sleep(RETRY_DELAY_MS * retry, signal);
          // continue() resumes from the last user or tool message; drop the failed reply first.
          agent.state.messages = agent.state.messages.slice(0, -1);
          await agent.continue();
          lastError = modelError(agent);
        }
        next = !lastError && active.inbox.length ? active.inbox.splice(0).join("\n\n") : undefined;
        // A message that continues this execution answers any question it asked.
        if (next !== undefined && active.waitFor) {
          const rest = active.waitFor.filter((id) => id !== WAIT_FOR_USER);
          active.waitFor = rest.length ? rest : null;
        }
      }
    } finally {
      clearTimeout(deadline);
      this.saveSession(runId, agent.state.messages);
    }

    if (active.reason === "cancelled") return this.finish(runId, "cancelled", report, null);
    if (active.reason) return this.finish(runId, "failed", report, STOP_TEXT[active.reason]);
    if (lastError) return this.finish(runId, "failed", report, `Model request failed: ${lastError}`);
    if (active.waitFor && !report) return this.suspend(runId, active.waitFor);
    // A parent does not finish while its sub-agents work: it waits for them and hears back.
    const unfinished = this.deps.tree.children(runId).filter((c) => !TERMINAL.has(c.status)).map((c) => c.id);
    if (unfinished.length) {
      bus.runEvent(runId, "error", { message: `Not finished: ${unfinished.length} sub-agent(s) are still working; waiting for them` });
      return this.suspend(runId, unfinished);
    }
    if (isReview && !verdict) this.deps.tree.recordVerdict(this.get(runId), false, `The reviewer finished without a verdict: ${fallbackReport(agent.state.messages).summary}`);
    return this.finish(runId, "succeeded", report ?? fallbackReport(agent.state.messages), null);
  }

  /** Claude Code or Codex does the work in the worktree; swarmd relays its events, commits and pushes. */
  private async executeCli(run: RunRow, agentRow: AgentRow, project: ProjectRow, ws: string, active: Active, message: string): Promise<void> {
    const { db, bus, backend, projects } = this.deps;
    const signal = active.controller.signal;
    const runtime = agentRow.runtime as CliRuntimeName;
    const available = this.deps.cli.availability(runtime);
    // Checked again at start, follow-ups included: it may have changed since it was queued.
    if (!available.ok) return this.finish(run.id, "failed", run.report, available.reason);
    if (!run.cliSession && this.deps.refreshMirror) {
      await projects.refresh(project.id).catch((e: Error) => bus.runEvent(run.id, "error", { message: `Could not refresh from GitHub, using the last mirror: ${e.message}` }));
    }
    // Idempotent: a follow-up finds its worktree as it left it.
    const base = run.baseBranch ?? project.defaultBranch;
    const cloned = await backend.call<{ resumed: boolean }>(ws, { op: "git.clone", scope: run.worktreeScope, mirror: basename(project.mirrorPath), branch: run.branch, base, files: await projects.files(project.id) }, { signal });
    if (!run.cliSession) bus.runEvent(run.id, "status", { status: "worktree", branch: run.branch, base, ...(cloned.resumed ? { resumed: true } : {}) });

    const stopReason = () => active.reason;
    const deadline = setTimeout(() => {
      active.reason ??= "time";
      active.controller.abort();
    }, run.limits.maxDurationMs);
    const x: CliExecution = {
      run, runtime, name: agentRow.name, role: agentRow.role, repo: project.githubRepo, defaultBranch: project.defaultBranch, project: projectLines(project.profile),
      model: agentRow.modelId === CLI_DEFAULT_MODEL ? null : agentRow.modelId, workstation: ws, signal, message,
      event: (type, data) => bus.runEvent(run.id, type, data),
      progress: (p) => {
        db.update(schema.runs).set({ turns: p.turns, tokensIn: p.tokensIn, tokensOut: p.tokensOut, estimatedUsd: p.estimatedUsd }).where(eq(schema.runs.id, run.id)).run();
        this.emit(run.id);
      },
      session: (id) => db.update(schema.runs).set({ cliSession: id }).where(eq(schema.runs.id, run.id)).run(),
    };
    let outcome;
    try {
      outcome = await this.cliRunner.execute(x);
      // Messages that came while it worked (message_agent, the person): the same execution goes on,
      // so its parent hears back only once everything asked of it is done.
      while (!outcome.error && active.inbox.length && !stopReason()) {
        outcome = await this.cliRunner.execute({ ...x, run: this.get(run.id), message: active.inbox.splice(0).join("\n\n") });
      }
    } catch (error) {
      const reason = stopReason();
      if (reason === "cancelled" || reason === "shutdown") throw error;
      if (reason) {
        await this.deps.pool.reap(ws).catch(() => undefined);
        // A reviewer's worktree is thrown away (it reviews the child's branch, and never pushes to it).
        if (run.kind === "review") {
          this.deps.tree.recordVerdict(this.get(run.id), false, `The reviewer stopped before a verdict: ${STOP_TEXT[reason]}`);
          return this.finish(run.id, "failed", null, STOP_TEXT[reason]);
        }
        // The time limit: keep what it did so the parent can review it or continue it. The CLI's
        // processes are gone first, so nothing is still writing to the worktree.
        const problem = await this.cliRunner.salvage({ ...x, run: this.get(run.id) });
        return this.finish(run.id, "failed", null, problem ? `${STOP_TEXT[reason]}; ${problem}` : STOP_TEXT[reason]);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
    }
    const reason = stopReason();
    if (reason === "cancelled") return this.finish(run.id, "cancelled", outcome.report, null);
    if (run.kind === "review") {
      // Like a native reviewer that ends without review_verdict: no verdict is a rejection.
      const v = outcome.verdict ?? { approved: false, comments: `The reviewer gave no verdict: ${outcome.error ?? outcome.report.summary}` };
      this.deps.tree.recordVerdict(this.get(run.id), v.approved, v.comments);
    }
    if (reason) return this.finish(run.id, "failed", outcome.report, STOP_TEXT[reason]);
    return this.finish(run.id, outcome.error && run.kind !== "review" ? "failed" : "succeeded", outcome.report, run.kind === "review" ? null : outcome.error);
  }

  /** Runs held back by a used-up quota: look again in a few minutes (nothing else may wake the scheduler). */
  private retryLater(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, QUOTA_RETRY_MS);
    this.retryTimer.unref();
  }

  /** Simulator runs held back by memory pressure: look again soon, not in five minutes. */
  private retryOnMemory(): void {
    if (this.memoryTimer) return;
    this.memoryTimer = setTimeout(() => {
      this.memoryTimer = null;
      this.schedule();
    }, MEMORY_RETRY_MS);
    this.memoryTimer.unref();
  }

  private runtimeOf(run: RunRow): AgentRow["runtime"] {
    return this.deps.agents.get(run.agentId).runtime;
  }

  private onEvent(runId: string, event: AgentEvent, c: { turns: number; tokensIn: number; tokensOut: number; costUsd: number }, base: { turns: number; costUsd: number }, limits: RunLimits, stop: (r: StopReason) => void, agent: Agent): void {
    const { bus, db } = this.deps;
    switch (event.type) {
      case "message_end": {
        const m = event.message;
        if (!("role" in m) || m.role !== "assistant") return;
        c.tokensIn += m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
        c.tokensOut += m.usage.output;
        c.costUsd += m.usage.cost.total;
        const text = m.content.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
        const calls = m.content.filter((x) => x.type === "toolCall").map((x) => x.name);
        if (text || m.errorMessage) bus.runEvent(runId, "assistant", { text, tools: calls, stopReason: m.stopReason, ...(m.errorMessage ? { error: m.errorMessage } : {}) });
        db.update(schema.runs).set({ tokensIn: c.tokensIn, tokensOut: c.tokensOut, costUsd: c.costUsd }).where(eq(schema.runs.id, runId)).run();
        this.emit(runId);
        const cap = this.deps.tree.ownCap(this.get(runId));
        if (cap !== null ? c.costUsd >= cap : c.costUsd - base.costUsd >= limits.maxCostUsd) stop("cost");
        return;
      }
      case "tool_execution_start":
        bus.runEvent(runId, "tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
        return;
      case "tool_execution_end":
        bus.runEvent(runId, "tool_end", { id: event.toolCallId, name: event.toolName, isError: event.isError, output: resultText(event.result), ms: event.durationMs ?? null, ...screenOf(runId, event.result) });
        return;
      case "turn_end":
        c.turns += 1;
        db.update(schema.runs).set({ turns: c.turns }).where(eq(schema.runs.id, runId)).run();
        this.saveSession(runId, agent.state.messages);
        this.emit(runId);
        return;
      case "turn_start":
        // Checked before the next model request, not after the last turn: a run whose final allowed
        // turn finishes it (report, stage_done) ends normally instead of failing on the limit.
        if (c.turns - base.turns >= limits.maxTurns) stop("turns");
        return;
      default:
    }
  }

  /**
   * A stored message for a run that is not executing: a finished run takes it as a follow-up, a run
   * waiting for the person takes it as the answer; one waiting for sub-agents gets it when they finish.
   */
  private deliverPending(runId: string): void {
    const run = this.get(runId);
    if (!run.pendingMessage || run.cleanedAt || this.active.has(runId)) return;
    if (run.status === "succeeded" || run.status === "failed") {
      // New work on a finished task: its old review and merge no longer describe what it will push.
      if (run.kind === "task") this.deps.db.update(schema.runs).set({ review: null, mergedAt: null }).where(eq(schema.runs.id, runId)).run();
      this.requeue(runId, run.pendingMessage);
    }
    else if (run.status === "waiting" && run.waitingFor?.includes(WAIT_FOR_USER)) this.answer(runId, "");
  }

  /** The answer a run asked for (ask_user): it goes on now, with whatever else arrived meanwhile. */
  private answer(runId: string, text: string): void {
    if (text) this.appendPending(runId, text);
    this.deps.db.update(schema.runs).set({ status: "queued", waitingFor: null }).where(eq(schema.runs.id, runId)).run();
    this.emit(runId);
    queueMicrotask(() => this.schedule());
  }

  private appendPending(runId: string, text: string): void {
    const run = this.get(runId);
    this.deps.db.update(schema.runs).set({ pendingMessage: run.pendingMessage ? `${run.pendingMessage}\n\n${text}` : text }).where(eq(schema.runs.id, runId)).run();
  }

  private requeue(runId: string, text: string): void {
    this.deps.db.update(schema.runs).set({ status: "queued", pendingMessage: text, error: null, endedAt: null, waitingFor: null }).where(eq(schema.runs.id, runId)).run();
    this.emit(runId);
    // Whoever requeued may be deep inside a finish; start it once the stack unwinds.
    queueMicrotask(() => this.schedule());
  }

  private saveSession(runId: string, messages: AgentMessage[], now = Date.now()): void {
    // Screenshots beyond the newest few are not kept: neither the model nor the database needs them.
    const values = { messages: keepRecentImages(messages) as unknown[], updatedAt: now };
    this.deps.db.insert(schema.agentSessions).values({ runId, ...values }).onConflictDoUpdate({ target: schema.agentSessions.runId, set: values }).run();
  }

  private finish(runId: string, status: RunRow["status"], report: RunReport | null, error: string | null, now = Date.now()): void {
    this.deps.db.update(schema.runs).set({ status, report, error, endedAt: now, waitingFor: null }).where(eq(schema.runs.id, runId)).run();
    this.deps.bus.runEvent(runId, "status", { status, ...(error ? { error } : {}) }, now);
    this.emit(runId);
    this.resumeWaiters(this.get(runId).treeId);
    this.notifyEnded(runId);
  }

  private notifyEnded(runId: string): void {
    try {
      this.hooks?.ended(this.get(runId));
    } catch (error) {
      this.deps.log("run hook failed", { runId, error: (error as Error).message });
    }
  }

  /** Ends this execution without finishing: the workstation is freed until the awaited runs are done. */
  private suspend(runId: string, ids: string[], now = Date.now()): void {
    this.deps.db.update(schema.runs).set({ status: "waiting", waitingFor: ids, endedAt: null }).where(eq(schema.runs.id, runId)).run();
    this.deps.bus.runEvent(runId, "status", { status: "waiting", for: ids }, now);
    this.emit(runId);
    this.resumeWaiters(this.get(runId).treeId);
    this.notifyEnded(runId);
  }

  /** Waiting runs whose awaited runs have all finished get their results and go back in the queue. */
  private resumeWaiters(treeId: string | null): void {
    if (!treeId) return;
    const waiting = this.deps.db.select().from(schema.runs).where(and(eq(schema.runs.treeId, treeId), eq(schema.runs.status, "waiting"))).all();
    for (const run of waiting) {
      const ids = run.waitingFor ?? [];
      // Waiting for the person: only their message resumes it.
      if (ids.includes(WAIT_FOR_USER)) continue;
      if (!ids.every((id) => TERMINAL.has(this.deps.tree.run(id).status))) continue;
      const results = this.deps.tree.resultsMessage(ids);
      this.deps.bus.runEvent(run.id, "results", { text: results, runs: ids });
      this.requeue(run.id, run.pendingMessage ? `${results}\n\nMessages that arrived while you waited:\n${run.pendingMessage}` : results);
    }
  }

  /** The tree tools, bound to one run and its current execution. */
  private treeOps(runId: string, active: Active): TreeToolOps {
    const { tree, bus } = this.deps;
    return {
      spawn: async (input) => {
        if (input.runtime && input.runtime !== "native" && input.needs?.length) {
          throw new TreeError("The simulator and browser tools are for native agents: let a native agent (e.g. QA) do the looking and tapping");
        }
        if (input.runtime && input.runtime !== "native") {
          const available = this.deps.cli.availability(input.runtime);
          if (!available.ok) throw new TreeError(`${input.runtime} is not available: ${available.reason}. Use another runtime.`);
        }
        const child = await tree.spawn(this.get(runId), input, () => !active.reason);
        bus.runEvent(child.id, "user", { text: child.pendingMessage ?? child.brief });
        bus.runEvent(runId, "status", { status: "spawned", child: child.id, name: child.title, branch: child.branch });
        this.emit(child.id);
        this.schedule();
        return { id: child.id, branch: child.branch, budgetUsd: child.budgetUsd ?? 0 };
      },
      runtimes: () => this.deps.cli.runtimesNote(),
      wait: (ids) => {
        const children = tree.children(runId);
        for (const id of ids ?? []) if (!children.some((c) => c.id === id)) throw new TreeError(`${id} is not one of your sub-agents`);
        const target = ids?.length ? ids : children.filter((c) => !TERMINAL.has(c.status)).map((c) => c.id);
        if (target.length === 0) {
          const done = children.filter((c) => c.kind === "task").map((c) => c.id);
          return done.length ? tree.resultsMessage(done) : "You have no sub-agents.";
        }
        if (target.every((id) => TERMINAL.has(tree.run(id).status))) return tree.resultsMessage(target);
        active.waitFor = target;
        return null;
      },
      message: (id, text) => {
        const parent = this.get(runId);
        const child = tree.child(parent, id, "task");
        // CLI workers spend the subscription, not the tree's budget: nothing to top up.
        if (TERMINAL.has(child.status) && this.runtimeOf(child) === "native") {
          const topped = tree.topUp(parent, child);
          if (topped) bus.runEvent(id, "status", { status: "budget", added: topped });
        }
        this.message(parent.agentId, id, text);
      },
      cancel: (id) => {
        tree.child(this.get(runId), id);
        this.cancelTree(id);
      },
      review: async (id) => {
        const parent = this.get(runId);
        const wanted = this.deps.projects.get(parent.projectId).profile?.reviewRuntime ?? "native";
        // The project's choice of reviewer, when that CLI can take it now; otherwise a native one.
        const runtime = wanted !== "native" && this.deps.cli.availability(wanted).ok ? wanted : "native";
        if (runtime !== wanted) bus.runEvent(runId, "error", { message: `The ${wanted} reviewer is not available now; using a native reviewer` });
        const review = await tree.startReview(parent, id, Date.now(), runtime);
        active.waitFor = [...(active.waitFor ?? []), review.id];
        bus.runEvent(review.id, "user", { text: review.pendingMessage ?? review.brief });
        this.emit(review.id);
        this.schedule();
        return review.id;
      },
      merge: async (id, signal) => {
        const out = await tree.merge(this.get(runId), id, signal);
        this.emit(id);
        return out;
      },
      openPullRequest: async (title, body) => {
        const pr = this.hooks?.pullRequest?.(this.get(runId), title, body) ?? { title, body };
        const url = await tree.openPullRequest(this.get(runId), pr.title, pr.body);
        bus.runEvent(runId, "status", { status: "pull_request", url });
        this.emit(runId);
        return url;
      },
    };
  }

  private toView(row: RunRow): RunView {
    const agent = this.deps.db.select({ name: schema.agents.name, role: schema.agents.role, runtime: schema.agents.runtime }).from(schema.agents).where(eq(schema.agents.id, row.agentId)).get();
    return {
      id: row.id, agentId: row.agentId, projectId: row.projectId, title: row.title, brief: row.brief, branch: row.branch,
      workstationId: row.workstationId, status: row.status, report: row.report, error: row.error, turns: row.turns,
      tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd, createdAt: row.createdAt, startedAt: row.startedAt, endedAt: row.endedAt,
      agentName: agent?.name ?? "?", agentRole: agent?.role ?? "?", treeId: row.treeId, parentRunId: row.parentRunId, depth: row.depth,
      kind: row.kind, baseBranch: row.baseBranch, budgetUsd: row.budgetUsd, review: row.review, reviewOf: row.reviewOf,
      mergedAt: row.mergedAt, prUrl: row.prUrl, waitingFor: row.waitingFor, missionId: row.missionId, prState: row.prState, cleanedAt: row.cleanedAt,
      runtime: agent?.runtime ?? "native", estimatedUsd: row.estimatedUsd, needs: row.needs ?? [],
    };
  }

  /** Simulators and browsers in use and waiting, and memory pressure (R6). */
  load(): MachineLoadView {
    const heavyRunning = [...this.active.keys()].filter((id) => this.get(id).needs?.length).length;
    const heavyQueued = this.deps.db.select({ needs: schema.runs.needs }).from(schema.runs).where(eq(schema.runs.status, "queued")).all().filter((r) => r.needs?.length).length;
    return { heavySlots: this.deps.heavySlots, heavyRunning, heavyQueued, memoryPressure: this.deps.memoryPressure() };
  }

  /** Screenshots kept for the dashboard are removed once their run ended more than `maxAgeMs` ago (R6). */
  pruneScreens(maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    let dirs: string[];
    try {
      dirs = readdirSync(this.deps.screensDir);
    } catch {
      return 0;
    }
    for (const runId of dirs) {
      const row = this.deps.db.select({ endedAt: schema.runs.endedAt, status: schema.runs.status }).from(schema.runs).where(eq(schema.runs.id, runId)).get();
      const stale = !row || (row.endedAt !== null && now - row.endedAt > maxAgeMs && TERMINAL.has(row.status));
      if (!stale) continue;
      rmSync(join(this.deps.screensDir, runId), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** A screenshot the run took (R6), for the dashboard; null when there is no such file. */
  screen(runId: string, file: string): Buffer | null {
    this.get(runId);
    if (!/^\d{3,6}\.jpg$/.test(file)) return null;
    try {
      return readFileSync(join(this.deps.screensDir, runId, file));
    } catch {
      return null;
    }
  }

  private emit(runId: string): void {
    this.deps.bus.publish({ kind: "run", run: this.view(runId) });
  }
}

function modelError(agent: Agent): string | null {
  const last = [...agent.state.messages].reverse().find((m) => "role" in m && m.role === "assistant");
  if (last && "stopReason" in last && last.stopReason === "error") return last.errorMessage ?? "unknown error";
  return null;
}

/** A tool that captured the screen: where the dashboard finds the picture. */
function screenOf(runId: string, result: unknown): { screen?: string } {
  const file = (result as { details?: { screen?: unknown } } | undefined)?.details?.screen;
  return typeof file === "string" && /^\d{3,6}\.jpg$/.test(file) ? { screen: `/api/runs/${runId}/screens/${file}` } : {};
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** A run that ended without calling report: keep its last words as the summary. */
function fallbackReport(messages: AgentMessage[]): RunReport {
  const last = [...messages].reverse().find((m) => "role" in m && m.role === "assistant");
  const text = last && "content" in last && Array.isArray(last.content)
    ? last.content.filter((c) => c.type === "text").map((c) => ("text" in c ? c.text : "")).join("\n").trim()
    : "";
  return { summary: text || "(the agent finished without a report)", tests: "(not reported)", unfinished: [] };
}

