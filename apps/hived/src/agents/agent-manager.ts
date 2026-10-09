import type { AgentState, Message, QueueInfo, Run, ToolGrant } from "@hive/core";
import { COMMUNICATION_PACK_ID, type AgentContext, type ToolpackRegistry, type TurnTrigger } from "@hive/tools";
import type { EventBus } from "../events/event-bus.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { AgentRow } from "./agent-service.ts";
import { TurnError, type AgentRuntime, type RuntimeEvent } from "./runtime/agent-runtime.ts";
import type { ResolvedEndpoint } from "../endpoints/endpoint-service.ts";

export interface ManagerLimits {
  readonly maxConcurrentRuns: number;
  readonly runTimeoutMs: number;
  readonly maxToolCallsPerRun: number;
  /** Quiet period before a turn starts, so bursts of messages become one turn. */
  readonly debounceMs: number;
  /** Unfinished agent-originated deliveries allowed per recipient and overall. */
  readonly maxPendingPerAgent: number;
  readonly maxPendingGlobal: number;
  /** Turns woken only by agents are dropped if they wait longer than this. */
  readonly agentOnlyQueueMs: number;
}

export const DEFAULT_LIMITS: ManagerLimits = {
  maxConcurrentRuns: 3,
  runTimeoutMs: 15 * 60 * 1000,
  maxToolCallsPerRun: 60,
  debounceMs: 1500,
  maxPendingPerAgent: 8,
  maxPendingGlobal: 64,
  agentOnlyQueueMs: 5 * 60 * 1000,
};

export interface AgentManagerDeps {
  readonly runs: RunStore;
  readonly bus: EventBus;
  readonly registry: ToolpackRegistry;
  readonly runtime: AgentRuntime;
  readonly findAgent: (agentId: string) => AgentRow | null;
  readonly grantsOf: (agentId: string) => ToolGrant[];
  readonly resolveEndpoint: (orgId: string, endpointId: string) => Promise<ResolvedEndpoint>;
  readonly chat: {
    getMessages(ids: readonly number[]): Message[];
    authorName(kind: Message["authorKind"], id: string): string;
    postSystemMessage(orgId: string, channelId: string, body: string, runId: string | null): Message;
    /** Kind and display title of a channel, and whether the agent is still a member. */
    describeChannel(channelId: string, agentId: string): { kind: "dm" | "group" | "agent_dm"; title: string; member: boolean } | null;
  };
  readonly log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  readonly limits?: Partial<ManagerLimits>;
  /** Called once per run after it settles, e.g. to release its leases. */
  readonly onRunSettled?: (runId: string) => void;
}

type StopReason = "stopped" | "timeout" | "tool_limit" | "deleted" | "shutdown";

interface ActiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  stopReason: StopReason | null;
}

const RESULT_PREVIEW = 2000;

/**
 * Owns agent turns: one active turn per agent, a global concurrency cap, and message
 * delivery at turn boundaries. Runs live in the backend; browsers only observe them.
 */
export class AgentManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly limits: ManagerLimits;
  private readonly settled = new Set<Promise<void>>();
  /** Debounce: an agent's queued run may start only after this time. */
  private readonly readyAt = new Map<string, number>();
  /** Why a working agent is blocked (e.g. waiting for a workstation), for the UI. */
  private readonly waiting = new Map<string, string>();
  private closed = false;

  constructor(private readonly deps: AgentManagerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  stateOf(agentId: string): AgentState {
    if (this.active.has(agentId)) return "working";
    return this.deps.runs.findQueued(agentId) ? "queued" : "idle";
  }

  /** A message reached an agent: fold it into the agent's next turn after a short quiet period. */
  notify(orgId: string, agentId: string, messageId: number): void {
    const queued = this.deps.runs.findQueued(agentId);
    const run = queued ? this.deps.runs.appendTrigger(queued.id, messageId) : this.deps.runs.createQueued(orgId, agentId, [messageId]);
    this.deps.bus.publish(orgId, { type: "run.updated", run });
    if (this.limits.debounceMs > 0) {
      this.readyAt.set(agentId, Date.now() + this.limits.debounceMs);
      setTimeout(() => this.pump(), this.limits.debounceMs + 5);
    }
    this.publishState(orgId, agentId);
    this.pump();
  }

  /** Queue caps for deliveries that come from other agents. People are never refused. */
  canAcceptFromAgent(agentId: string): boolean {
    const queued = this.deps.runs.listQueued();
    const mine = queued.find((r) => r.agentId === agentId)?.triggerMessageIds.length ?? 0;
    const all = queued.reduce((n, r) => n + r.triggerMessageIds.length, 0);
    return mine < this.limits.maxPendingPerAgent && all < this.limits.maxPendingGlobal;
  }

  queueInfo(agentId: string): QueueInfo | undefined {
    const waitingFor = this.waiting.get(agentId);
    if (this.active.has(agentId)) return waitingFor ? { position: 0, waitingFor } : undefined;
    const queued = this.deps.runs.listQueued();
    const index = queued.findIndex((r) => r.agentId === agentId);
    if (index < 0) return undefined;
    const full = this.active.size >= this.limits.maxConcurrentRuns;
    return { position: index + 1, waitingFor: full ? "a free run slot" : null };
  }

  /** Tools report long waits (e.g. a workstation lease) so people can see why an agent is idle. */
  setWaiting(agentId: string, reason: string | null): void {
    if (reason) this.waiting.set(agentId, reason);
    else this.waiting.delete(agentId);
    const orgId = this.deps.findAgent(agentId)?.orgId;
    if (orgId) this.publishState(orgId, agentId);
  }

  /** Aborts the agent's current turn. Queued messages still run afterwards. */
  stop(agentId: string): boolean {
    return this.abort(agentId, "stopped");
  }

  onAgentDeleted(agentId: string): void {
    this.abort(agentId, "deleted");
  }

  /** Called once at boot, before serving requests. */
  recover(): void {
    const { interrupted, queued } = this.deps.runs.recover();
    for (const run of interrupted) {
      const orgId = this.deps.runs.orgOf(run.id);
      if (!orgId) continue;
      this.deps.runs.addActivity(run, "notice", { text: "Interrupted by a Hive restart; the turn was not replayed." });
      for (const channelId of this.channelsOf(run)) {
        this.deps.chat.postSystemMessage(orgId, channelId, "The previous turn was interrupted by a restart. Send a message to continue.", run.id);
      }
    }
    if (queued.length > 0) this.deps.log("info", "rescheduling queued runs", { count: queued.length });
    this.pump();
  }

  /** Stops accepting work and aborts active turns; resolves when they have settled. */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const agentId of [...this.active.keys()]) this.abort(agentId, "shutdown");
    await Promise.allSettled([...this.settled]);
  }

  /** Resolves when no turn is active and nothing startable is queued (used by tests). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.settled.size > 0) {
        await Promise.allSettled([...this.settled]);
        continue;
      }
      const now = Date.now();
      const pending = [...this.readyAt.entries()].filter(([agentId, at]) => at > now && this.deps.runs.findQueued(agentId));
      if (pending.length === 0) return;
      await Bun.sleep(Math.max(...pending.map(([, at]) => at)) - now + 10);
    }
  }

  private abort(agentId: string, reason: StopReason): boolean {
    const active = this.active.get(agentId);
    if (!active) return false;
    // Deletion wins over any earlier reason: the run row is about to disappear.
    active.stopReason = reason === "deleted" ? "deleted" : (active.stopReason ?? reason);
    active.controller.abort(new Error(reason));
    return true;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.active.size < this.limits.maxConcurrentRuns) {
      const next = this.nextStartable();
      if (!next) return;
      const active: ActiveRun = { runId: next.id, controller: new AbortController(), stopReason: null };
      this.active.set(next.agentId, active);
      const done = this.execute(next, active).catch((error: unknown) => this.onCrash(next, error)).finally(() => {
        this.active.delete(next.agentId);
        this.waiting.delete(next.agentId);
        try {
          this.deps.onRunSettled?.(next.id);
        } catch (error) {
          this.deps.log("error", "run settle hook failed", { runId: next.id, error: String(error) });
        }
        this.settled.delete(done);
        const orgId = this.deps.runs.orgOf(next.id);
        if (orgId) this.publishState(orgId, next.agentId);
        this.pump();
      });
      this.settled.add(done);
    }
  }

  /** Last line of defence: a bookkeeping failure must never become an unhandled rejection. */
  private onCrash(run: Run, error: unknown): void {
    this.deps.log("error", "run crashed", { runId: run.id, agentId: run.agentId, error: String(error) });
    const current = this.deps.runs.get(run.id);
    if (current && (current.status === "queued" || current.status === "running")) {
      try {
        this.deps.runs.finish(run.id, "failed", "Internal error while running this turn");
      } catch (finishError) {
        this.deps.log("error", "could not mark crashed run failed", { runId: run.id, error: String(finishError) });
      }
    }
  }

  private nextStartable(): Run | null {
    // Oldest queued run whose agent is free and past its debounce. Queued runs are few, so a scan is fine.
    const now = Date.now();
    for (const run of this.deps.runs.listQueued()) {
      if (this.active.has(run.agentId) || (this.readyAt.get(run.agentId) ?? 0) > now) continue;
      if (now - run.createdAt > this.limits.agentOnlyQueueMs && this.agentOnly(run)) {
        this.dropStale(run);
        continue;
      }
      return run;
    }
    return null;
  }

  private agentOnly(run: Run): boolean {
    return this.deps.chat.getMessages(run.triggerMessageIds).every((m) => m.authorKind !== "user");
  }

  private dropStale(run: Run): void {
    const dropped = this.deps.runs.finish(run.id, "failed", "Dropped: messages from other agents waited too long");
    const orgId = this.deps.runs.orgOf(run.id);
    if (orgId) {
      this.deps.bus.publish(orgId, { type: "run.updated", run: dropped });
      this.publishState(orgId, run.agentId);
    }
  }

  private async execute(queuedRun: Run, active: ActiveRun): Promise<void> {
    const orgId = this.deps.runs.orgOf(queuedRun.id);
    if (!orgId) return;
    let run = this.deps.runs.markRunning(queuedRun.id);
    this.deps.bus.publish(orgId, { type: "run.updated", run });
    this.publishState(orgId, run.agentId);

    const agent = this.deps.findAgent(run.agentId);
    // Membership is rechecked at delivery: messages from channels the agent has left are dropped.
    const messages = this.deps.chat.getMessages(run.triggerMessageIds).filter((m) => this.deps.chat.describeChannel(m.channelId, run.agentId)?.member);
    const channels = [...new Set(messages.map((m) => m.channelId))];
    const trigger = buildTrigger(messages);
    let replied = false;
    const timeout = setTimeout(() => this.abort(run.agentId, "timeout"), this.limits.runTimeoutMs);
    let toolCalls = 0;
    let secret: string | null = null;
    const scrub = (text: string): string => (secret && secret.length >= 8 ? text.replaceAll(secret, "[redacted]") : text);

    const emit = (event: RuntimeEvent): void => {
      try {
        record(event);
      } catch (error) {
        // Never let bookkeeping failures (for example a deleted agent) break the model loop.
        this.deps.log("error", "failed to record runtime event", { runId: run.id, kind: event.kind, error: String(error) });
      }
    };
    const record = (event: RuntimeEvent): void => {
      if (event.kind === "usage") {
        const updated = this.deps.runs.addUsage({
          orgId, runId: run.id, agentId: run.agentId, endpointId: agent?.endpointId ?? null,
          provider: event.provider, model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens, costUsd: event.costUsd,
        });
        this.deps.bus.publish(orgId, { type: "run.updated", run: updated });
        return;
      }
      if (event.kind === "tool_call" && ++toolCalls > this.limits.maxToolCallsPerRun) this.abort(run.agentId, "tool_limit");
      if (event.kind === "tool_result" && event.name === "send_message" && !event.isError) replied = true;
      const activity = this.deps.runs.addActivity(run, event.kind, activityPayload(event, scrub));
      this.deps.bus.publish(orgId, { type: "activity.created", activity });
    };

    try {
      if (!agent) throw new Error("Agent no longer exists");
      if (!agent.endpointId) throw new Error("Agent has no model endpoint; choose one in its settings");
      const endpoint = await this.deps.resolveEndpoint(orgId, agent.endpointId);
      secret = endpoint.apiKey;
      const grants = this.deps.grantsOf(agent.id);
      if (messages.length === 0) throw new Error("No deliverable messages (the agent left those channels)");
      const context: AgentContext = { agentId: agent.id, orgId, runId: run.id, grants, currentGrants: () => this.deps.grantsOf(agent.id), trigger };
      const toolset = this.deps.registry.resolve(context);
      if (!toolset.tools.some((t) => t.toolpackId === COMMUNICATION_PACK_ID && t.tool.name === "send_message")) {
        emit({ kind: "notice", text: "send_message is not granted, so this agent cannot reply in chat." });
      }
      const result = await this.deps.runtime.runTurn({
        agent: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, modelId: agent.modelId, thinkingLevel: agent.thinkingLevel },
        endpoint,
        context,
        tools: toolset.tools,
        guidance: toolset.guidance,
        prompt: this.formatPrompt(messages, agent.id),
        sessionEntries: this.deps.runs.loadSession(agent.id),
        signal: active.controller.signal,
        onEvent: emit,
      });
      if (active.stopReason) throw new TurnError(active.stopReason, result.sessionEntries);
      this.deps.runs.saveSession(agent.id, result.sessionEntries);
      run = this.deps.runs.finish(run.id, "succeeded", null);
      if (!replied && trigger.humanChannelIds.length > 0) {
        emit({ kind: "notice", text: "Turn ended without send_message; nothing was posted to chat." });
      }
    } catch (error) {
      const reason = active.stopReason;
      const text = scrub(describeFailure(reason, error));
      const status = reason === "stopped" || reason === "shutdown" || reason === "deleted" ? "interrupted" : "failed";
      const gone = reason === "deleted" || !this.deps.runs.get(run.id) || !this.deps.findAgent(run.agentId);
      if (!gone) {
        if (agent && error instanceof TurnError && error.sessionEntries) this.deps.runs.saveSession(agent.id, error.sessionEntries);
        run = this.deps.runs.finish(run.id, status, text);
        emit({ kind: "error", text });
        // Only people's channels get failure notices; agents would just wake each other up.
        for (const channelId of trigger.humanChannelIds) {
          this.deps.chat.postSystemMessage(orgId, channelId, status === "interrupted" ? `Turn stopped (${reason}).` : `Turn failed: ${text}`, run.id);
        }
      }
      this.deps.log(status === "failed" ? "warn" : "info", "run ended early", { runId: run.id, agentId: run.agentId, reason: reason ?? "error" });
    } finally {
      clearTimeout(timeout);
    }
    if (this.deps.runs.get(run.id)) this.deps.bus.publish(orgId, { type: "run.updated", run });
  }

  /** Server-written source headers; message text cannot forge them. */
  private formatPrompt(messages: readonly Message[], agentId: string): string {
    const kinds = { dm: "private chat with your owner", group: "group", agent_dm: "private chat with an agent" } as const;
    return messages
      .map((m) => {
        const ch = this.deps.chat.describeChannel(m.channelId, agentId);
        const where = ch ? (ch.kind === "group" ? `group "${ch.title}"` : kinds[ch.kind]) : "channel";
        const who = m.authorName || this.deps.chat.authorName(m.authorKind, m.authorId);
        const role = m.authorKind === "user" ? "person" : m.authorKind;
        const reply = m.replyToId ? ` · reply to #${m.replyToId}` : "";
        const mentioned = m.mentions.includes(agentId) ? " · you were mentioned" : "";
        return `[channel_id=${m.channelId} · ${where} · message #${m.id}${reply}${mentioned}]\n${who} (${role}): ${m.body}`;
      })
      .join("\n\n");
  }

  /** Channels where a person asked for this run; those are the ones owed a notice. */
  private channelsOf(run: Run): string[] {
    return [...new Set(this.deps.chat.getMessages(run.triggerMessageIds).filter((m) => m.authorKind === "user").map((m) => m.channelId))];
  }

  private publishState(orgId: string, agentId: string): void {
    const queue = this.queueInfo(agentId);
    this.deps.bus.publish(orgId, { type: "agent.state", agentId, state: this.stateOf(agentId), ...(queue ? { queue } : {}) });
  }
}

/** The chain and the channels where a person spoke, derived from the turn's own input. */
function buildTrigger(messages: readonly Message[]): TurnTrigger {
  const human = messages.filter((m) => m.authorKind === "user");
  const lead = human.at(-1) ?? messages.at(-1);
  return {
    chainId: lead?.chainId ?? null,
    humanChannelIds: [...new Set(human.map((m) => m.channelId))],
    channelIds: [...new Set(messages.map((m) => m.channelId))],
  };
}

function activityPayload(event: Exclude<RuntimeEvent, { kind: "usage" }>, scrub: (t: string) => string): Record<string, unknown> {
  switch (event.kind) {
    case "assistant_text":
    case "thinking":
    case "notice":
    case "error":
      return { text: clip(scrub(event.text)) };
    case "tool_call":
      return { toolCallId: event.toolCallId, name: event.name, args: event.args };
    case "tool_result":
      return { toolCallId: event.toolCallId, name: event.name, isError: event.isError, text: clip(scrub(event.text)) };
  }
}

function describeFailure(reason: StopReason | null, error: unknown): string {
  if (reason === "timeout") return "The turn hit its time limit.";
  if (reason === "tool_limit") return "The turn hit its tool-call limit.";
  if (reason) return reason;
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function clip(text: string): string {
  return text.length <= RESULT_PREVIEW ? text : `${text.slice(0, RESULT_PREVIEW)}… [truncated ${text.length - RESULT_PREVIEW} chars]`;
}
