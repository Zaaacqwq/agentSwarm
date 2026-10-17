import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { CreateRun, RunEventView, RunReport, RunView } from "@agentswarm/contracts";
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
import { workstationTools } from "./tools.ts";
import { systemPrompt } from "./prompts.ts";

export type RunRow = typeof schema.runs.$inferSelect;

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 40, maxDurationMs: 30 * 60_000, maxCostUsd: 1 };
/** A failed model request is retried this many times before the run fails. */
export const MODEL_RETRIES = 2;
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
  readonly maxConcurrent: number;
  readonly limits?: RunLimits;
  /** Fetch GitHub into the mirror before a run clones it (off in tests with local remotes). */
  readonly refreshMirror: boolean;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

type StopReason = "cancelled" | "turns" | "time" | "cost";

interface Active {
  readonly controller: AbortController;
  agent: Agent | null;
  reason: StopReason | null;
  done: Promise<void>;
  /** Messages that arrived while the agent was not taking input (starting up, or just finishing). */
  readonly inbox: string[];
}

const STOP_TEXT: Record<Exclude<StopReason, "cancelled">, string> = {
  turns: "Stopped: the run reached its turn limit",
  time: "Stopped: the run reached its time limit",
  cost: "Stopped: the run reached its cost limit",
};

export class RunService {
  private readonly deps: RunDeps;
  private readonly active = new Map<string, Active>();
  private scheduling = false;

  constructor(deps: RunDeps) {
    this.deps = deps;
  }

  // ---- queries --------------------------------------------------------------------------

  list(filter: { agentId?: string; projectId?: string } = {}, limit = 50): RunView[] {
    const where = filter.agentId ? eq(schema.runs.agentId, filter.agentId) : filter.projectId ? eq(schema.runs.projectId, filter.projectId) : undefined;
    return this.deps.db.select().from(schema.runs).where(where).orderBy(desc(schema.runs.createdAt)).limit(Math.min(limit, 200)).all().map(view);
  }

  get(id: string): RunRow {
    const row = this.deps.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    if (!row) throw notFound("No such run");
    return row;
  }

  view(id: string): RunView {
    return view(this.get(id));
  }

  events(runId: string, after = 0, limit = 500): RunEventView[] {
    this.get(runId);
    return this.deps.db.select().from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.id, after)))
      .orderBy(asc(schema.runEvents.id)).limit(Math.min(limit, 1000)).all()
      .map((r) => ({ id: r.id, runId: r.runId, type: r.type as RunEventView["type"], data: r.data, createdAt: r.createdAt }));
  }

  // ---- commands -------------------------------------------------------------------------

  create(actor: string, agentId: string, input: CreateRun, now = Date.now()): RunView {
    const agent = this.deps.agents.get(agentId);
    const project = this.deps.projects.get(agent.projectId);
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
    const leaf = `${slug}-${randomBytes(3).toString("hex")}`;
    const row: RunRow = {
      id: newId("run"), agentId, projectId: project.id, title: input.title.trim(), brief: input.brief,
      branch: `swarm/${project.slug}/${leaf}`, worktreeScope: `worktrees/${project.slug}/${leaf}`, workstationId: null,
      status: "queued", pendingMessage: input.brief, report: null, error: null, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
      limits: this.deps.limits ?? DEFAULT_LIMITS, createdAt: now, startedAt: null, endedAt: null,
    };
    this.deps.db.insert(schema.runs).values(row).run();
    audit(this.deps.db, actor, "run.create", row.id, { agentId, branch: row.branch }, now);
    this.deps.bus.runEvent(row.id, "user", { text: input.brief }, now);
    this.emit(row.id);
    this.schedule();
    return view(row);
  }

  /** While running, steers the agent; afterwards, queues a follow-up on the same worktree. */
  message(actor: string, runId: string, text: string, now = Date.now()): RunView {
    const run = this.get(runId);
    this.deps.bus.runEvent(runId, "user", { text }, now);
    const active = this.active.get(runId);
    if (active?.agent?.state.isStreaming) {
      active.agent.steer({ role: "user", content: text, timestamp: now });
    } else if (active) {
      active.inbox.push(text);
    } else {
      const pending = run.status === "queued" && run.pendingMessage ? `${run.pendingMessage}\n\n${text}` : text;
      this.deps.db.update(schema.runs).set({ status: "queued", pendingMessage: pending, error: null, endedAt: null }).where(eq(schema.runs.id, runId)).run();
      this.emit(runId);
      this.schedule();
    }
    audit(this.deps.db, actor, "run.message", runId, {}, now);
    return this.view(runId);
  }

  cancel(actor: string, runId: string, now = Date.now()): RunView {
    const run = this.get(runId);
    const active = this.active.get(runId);
    if (active) {
      active.reason = "cancelled";
      active.controller.abort();
      active.agent?.abort();
      if (run.workstationId) void this.deps.pool.reap(run.workstationId).catch(() => undefined);
    } else if (run.status === "queued") {
      this.finish(runId, "cancelled", null, null, now);
    } else {
      throw conflict(`The run is already ${run.status}`);
    }
    audit(this.deps.db, actor, "run.cancel", runId, {}, now);
    return this.view(runId);
  }

  /** After a restart nothing is running: interrupted runs become failed and can be resumed with a message. */
  recover(now = Date.now()): void {
    const stale = this.deps.db.select().from(schema.runs).where(eq(schema.runs.status, "running")).all();
    for (const run of stale) this.finish(run.id, "failed", null, "Interrupted by a agentSwarm restart; send a message to continue", now);
    this.schedule();
  }

  /** Cancels everything running and waits for it to wind down (shutdown and tests). */
  async stopAll(): Promise<void> {
    for (const [id, active] of this.active) {
      active.reason = "cancelled";
      active.controller.abort();
      active.agent?.abort();
      this.deps.log("run cancelled for shutdown", { runId: id });
    }
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** Resolves when the run is no longer running (tests). */
  async settled(runId: string): Promise<RunView> {
    await this.active.get(runId)?.done;
    return this.view(runId);
  }

  // ---- scheduling -----------------------------------------------------------------------

  schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      const queued = this.deps.db.select().from(schema.runs).where(eq(schema.runs.status, "queued")).orderBy(asc(schema.runs.createdAt)).all();
      const workstations = new Map(this.deps.pool.list().map((w) => [w.id, w.status]));
      for (const run of queued) {
        if (this.active.size >= this.deps.maxConcurrent) break;
        // A follow-up needs the workstation that holds its worktree.
        if (run.workstationId && (workstations.get(run.workstationId) ?? "unhealthy") === "unhealthy") {
          this.finish(run.id, "failed", run.report, `Its workstation ${run.workstationId} is unavailable; start a new run`);
          continue;
        }
        const ws = this.deps.pool.acquire(run.id, run.workstationId);
        if (ws) this.start(run, ws);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private start(run: RunRow, ws: string, now = Date.now()): void {
    const active: Active = { controller: new AbortController(), agent: null, reason: null, done: Promise.resolve(), inbox: [] };
    this.active.set(run.id, active);
    this.deps.db.update(schema.runs).set({ status: "running", workstationId: ws, startedAt: run.startedAt ?? now, error: null, endedAt: null }).where(eq(schema.runs.id, run.id)).run();
    this.deps.bus.runEvent(run.id, "status", { status: "running", workstation: ws }, now);
    this.emit(run.id);
    active.done = this.execute(run.id, ws, active)
      .catch((error: Error) => {
        if (active.reason === "cancelled") return this.finish(run.id, "cancelled", null, null);
        this.deps.log("run failed", { runId: run.id, error: error.message });
        this.finish(run.id, "failed", null, error.message.slice(0, 500));
      })
      .finally(async () => {
        // Whatever the agent left running (servers, setsid loops) dies with the run.
        await this.deps.pool.reap(ws).catch((e: Error) => this.deps.log("reap failed", { ws, error: e.message }));
        this.deps.pool.release(ws, run.id);
        this.active.delete(run.id);
        // A message that arrived as the run ended starts a follow-up.
        if (active.inbox.length && active.reason !== "cancelled") this.requeue(run.id, active.inbox.splice(0).join("\n\n"));
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

    // Resolve the model first: a bad model id should not leave a half-prepared worktree behind.
    const { model, streamFn } = await gateway.resolve(agentRow.endpointId, agentRow.modelId);
    const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.runId, runId)).get();
    if (!session) {
      if (this.deps.refreshMirror) {
        await projects.refresh(project.id).catch((e: Error) => bus.runEvent(runId, "error", { message: `Could not refresh from GitHub, using the last mirror: ${e.message}` }));
      }
      await backend.call(ws, { op: "git.clone", scope: run.worktreeScope, mirror: basename(project.mirrorPath), branch: run.branch, base: project.defaultBranch }, { signal });
      bus.runEvent(runId, "status", { status: "worktree", branch: run.branch, base: project.defaultBranch });
    }

    let report: RunReport | null = null;
    const tools = workstationTools({
      backend, workstation: ws, scope: run.worktreeScope,
      push: (s) => relay.push(this.get(runId), s),
      report: (r) => (report = r),
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt({ name: agentRow.name, role: agentRow.role, instructions: agentRow.instructions, repo: project.githubRepo, defaultBranch: project.defaultBranch, branch: run.branch }),
        model,
        tools,
        messages: (session?.messages ?? []) as AgentMessage[],
      },
      streamFn,
      sessionId: runId,
    });
    active.agent = agent;
    signal.addEventListener("abort", () => agent.abort(), { once: true });
    if (signal.aborted) agent.abort();

    const counters = { turns: run.turns, tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd };
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
      }
    } finally {
      clearTimeout(deadline);
      this.saveSession(runId, agent.state.messages);
    }

    if (active.reason === "cancelled") return this.finish(runId, "cancelled", report, null);
    if (active.reason) return this.finish(runId, "failed", report, STOP_TEXT[active.reason]);
    if (lastError) return this.finish(runId, "failed", report, `Model request failed: ${lastError}`);
    return this.finish(runId, "succeeded", report ?? fallbackReport(agent.state.messages), null);
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
        if (c.costUsd - base.costUsd >= limits.maxCostUsd) stop("cost");
        return;
      }
      case "tool_execution_start":
        bus.runEvent(runId, "tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
        return;
      case "tool_execution_end":
        bus.runEvent(runId, "tool_end", { id: event.toolCallId, name: event.toolName, isError: event.isError, output: resultText(event.result), ms: event.durationMs ?? null });
        return;
      case "turn_end":
        c.turns += 1;
        db.update(schema.runs).set({ turns: c.turns }).where(eq(schema.runs.id, runId)).run();
        this.saveSession(runId, agent.state.messages);
        this.emit(runId);
        if (c.turns - base.turns >= limits.maxTurns) stop("turns");
        return;
      default:
    }
  }

  private requeue(runId: string, text: string): void {
    this.deps.db.update(schema.runs).set({ status: "queued", pendingMessage: text, error: null, endedAt: null }).where(eq(schema.runs.id, runId)).run();
    this.emit(runId);
  }

  private saveSession(runId: string, messages: AgentMessage[], now = Date.now()): void {
    const values = { messages: messages as unknown[], updatedAt: now };
    this.deps.db.insert(schema.agentSessions).values({ runId, ...values }).onConflictDoUpdate({ target: schema.agentSessions.runId, set: values }).run();
  }

  private finish(runId: string, status: RunRow["status"], report: RunReport | null, error: string | null, now = Date.now()): void {
    this.deps.db.update(schema.runs).set({ status, report, error, endedAt: now }).where(eq(schema.runs.id, runId)).run();
    this.deps.bus.runEvent(runId, "status", { status, ...(error ? { error } : {}) }, now);
    this.emit(runId);
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

function view(row: RunRow): RunView {
  return {
    id: row.id, agentId: row.agentId, projectId: row.projectId, title: row.title, brief: row.brief, branch: row.branch,
    workstationId: row.workstationId, status: row.status, report: row.report, error: row.error, turns: row.turns,
    tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd, createdAt: row.createdAt, startedAt: row.startedAt, endedAt: row.endedAt,
  };
}
