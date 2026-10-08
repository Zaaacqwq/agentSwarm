import type { AgentState, Message, Run, ToolGrant } from "@hive/core";
import { COMMUNICATION_PACK_ID, type AgentContext, type ToolpackRegistry } from "@hive/tools";
import type { EventBus } from "../events/event-bus.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { AgentRow } from "./agent-service.ts";
import type { AgentRuntime, RuntimeEvent } from "./runtime/agent-runtime.ts";
import type { ResolvedEndpoint } from "../endpoints/endpoint-service.ts";

export interface ManagerLimits {
  readonly maxConcurrentRuns: number;
  readonly runTimeoutMs: number;
  readonly maxToolCallsPerRun: number;
}

export const DEFAULT_LIMITS: ManagerLimits = { maxConcurrentRuns: 3, runTimeoutMs: 15 * 60 * 1000, maxToolCallsPerRun: 60 };

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
  };
  readonly log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  readonly limits?: Partial<ManagerLimits>;
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
  private closed = false;

  constructor(private readonly deps: AgentManagerDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  stateOf(agentId: string): AgentState {
    if (this.active.has(agentId)) return "working";
    return this.deps.runs.findQueued(agentId) ? "queued" : "idle";
  }

  /** A human message reached an agent: fold it into the agent's next turn. */
  notify(orgId: string, agentId: string, messageId: number): void {
    const queued = this.deps.runs.findQueued(agentId);
    const run = queued ? this.deps.runs.appendTrigger(queued.id, messageId) : this.deps.runs.createQueued(orgId, agentId, [messageId]);
    this.deps.bus.publish(orgId, { type: "run.updated", run });
    this.publishState(orgId, agentId);
    this.pump();
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
    while (this.settled.size > 0) await Promise.allSettled([...this.settled]);
  }

  private abort(agentId: string, reason: StopReason): boolean {
    const active = this.active.get(agentId);
    if (!active) return false;
    active.stopReason ??= reason;
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
      const done = this.execute(next, active).finally(() => {
        this.active.delete(next.agentId);
        this.settled.delete(done);
        const orgId = this.deps.runs.orgOf(next.id);
        if (orgId) this.publishState(orgId, next.agentId);
        this.pump();
      });
      this.settled.add(done);
    }
  }

  private nextStartable(): Run | null {
    // Oldest queued run whose agent is free. Queued runs are few, so a scan is fine.
    return this.deps.runs.listQueued().find((r) => !this.active.has(r.agentId)) ?? null;
  }

  private async execute(queuedRun: Run, active: ActiveRun): Promise<void> {
    const orgId = this.deps.runs.orgOf(queuedRun.id);
    if (!orgId) return;
    let run = this.deps.runs.markRunning(queuedRun.id);
    this.deps.bus.publish(orgId, { type: "run.updated", run });
    this.publishState(orgId, run.agentId);

    const agent = this.deps.findAgent(run.agentId);
    const messages = this.deps.chat.getMessages(run.triggerMessageIds);
    const channels = [...new Set(messages.map((m) => m.channelId))];
    let replied = false;
    const timeout = setTimeout(() => this.abort(run.agentId, "timeout"), this.limits.runTimeoutMs);
    let toolCalls = 0;

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
      const activity = this.deps.runs.addActivity(run, event.kind, activityPayload(event));
      this.deps.bus.publish(orgId, { type: "activity.created", activity });
    };

    try {
      if (!agent) throw new Error("Agent no longer exists");
      if (!agent.endpointId) throw new Error("Agent has no model endpoint; choose one in its settings");
      const endpoint = await this.deps.resolveEndpoint(orgId, agent.endpointId);
      const grants = this.deps.grantsOf(agent.id);
      const context: AgentContext = { agentId: agent.id, orgId, runId: run.id, grants, currentGrants: () => this.deps.grantsOf(agent.id) };
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
        prompt: this.formatPrompt(messages),
        sessionEntries: this.deps.runs.loadSession(agent.id),
        signal: active.controller.signal,
        onEvent: emit,
      });
      if (active.stopReason) throw new Error(active.stopReason);
      this.deps.runs.saveSession(agent.id, result.sessionEntries);
      run = this.deps.runs.finish(run.id, "succeeded", null);
      if (!replied && channels.length > 0) {
        emit({ kind: "notice", text: "Turn ended without send_message; nothing was posted to chat." });
      }
    } catch (error) {
      const reason = active.stopReason;
      const text = describeFailure(reason, error);
      const status = reason === "stopped" || reason === "shutdown" || reason === "deleted" ? "interrupted" : "failed";
      if (reason !== "deleted") {
        run = this.deps.runs.finish(run.id, status, text);
        emit({ kind: "error", text });
        for (const channelId of channels) {
          this.deps.chat.postSystemMessage(orgId, channelId, status === "interrupted" ? `Turn stopped (${reason}).` : `Turn failed: ${text}`, run.id);
        }
      }
      this.deps.log(status === "failed" ? "warn" : "info", "run ended early", { runId: run.id, agentId: run.agentId, reason: reason ?? "error" });
    } finally {
      clearTimeout(timeout);
    }
    if (active.stopReason !== "deleted") this.deps.bus.publish(orgId, { type: "run.updated", run });
  }

  private formatPrompt(messages: readonly Message[]): string {
    return messages
      .map((m) => {
        const who = this.deps.chat.authorName(m.authorKind, m.authorId);
        return `[channel_id=${m.channelId} · direct message · message #${m.id}]\n${who} (${m.authorKind}): ${m.body}`;
      })
      .join("\n\n");
  }

  private channelsOf(run: Run): string[] {
    return [...new Set(this.deps.chat.getMessages(run.triggerMessageIds).map((m) => m.channelId))];
  }

  private publishState(orgId: string, agentId: string): void {
    this.deps.bus.publish(orgId, { type: "agent.state", agentId, state: this.stateOf(agentId) });
  }
}

function activityPayload(event: Exclude<RuntimeEvent, { kind: "usage" }>): Record<string, unknown> {
  switch (event.kind) {
    case "assistant_text":
    case "thinking":
    case "notice":
    case "error":
      return { text: clip(event.text) };
    case "tool_call":
      return { toolCallId: event.toolCallId, name: event.name, args: event.args };
    case "tool_result":
      return { toolCallId: event.toolCallId, name: event.name, isError: event.isError, text: clip(event.text) };
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
