import type { ThinkingLevel } from "@hive/core";
import type { AgentContext, ResolvedTool } from "@hive/tools";
import type { ResolvedEndpoint } from "../../endpoints/endpoint-service.ts";

/** Streamed facts about one turn; the manager turns them into activity, usage and UI events. */
export type RuntimeEvent =
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool_call"; readonly toolCallId: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "tool_result"; readonly toolCallId: string; readonly name: string; readonly isError: boolean; readonly text: string }
  | {
      readonly kind: "usage";
      readonly provider: string;
      readonly model: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly costUsd: number;
    }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export interface RuntimeAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
}

export interface TurnInput {
  readonly agent: RuntimeAgent;
  readonly endpoint: ResolvedEndpoint;
  readonly context: AgentContext;
  readonly tools: readonly ResolvedTool[];
  readonly guidance: readonly string[];
  /** The incoming messages for this turn, already formatted with channel headers. */
  readonly prompt: string;
  /** Checkpoint from the previous turn, or null for a fresh conversation. */
  readonly sessionEntries: readonly unknown[] | null;
  readonly signal: AbortSignal;
  readonly onEvent: (event: RuntimeEvent) => void;
}

export interface TurnResult {
  readonly sessionEntries: unknown[];
}

/** Hive's seam around Pi, so the SDK can be swapped or faked without touching scheduling. */
export interface AgentRuntime {
  runTurn(input: TurnInput): Promise<TurnResult>;
}

/** A turn that ended early but still produced context worth keeping (for example a stop or timeout). */
export class TurnError extends Error {
  constructor(
    message: string,
    readonly sessionEntries: unknown[] | null,
  ) {
    super(message);
  }
}
