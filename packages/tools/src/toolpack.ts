import type { Static, TSchema } from "typebox";
import type { ToolGrant } from "@hive/core";

/** r: read-only, w: writes, rw: both, claim: needs a lease first (P2+). */
export type ToolAccess = "r" | "w" | "rw" | "claim";

/** Scarce resources a pack may introduce. P1 declares none; P2 adds workstation-write. */
export type LeaseKind = "workstation-write" | "heavy-task" | "desktop" | "xcode-build" | "simulator";

export interface HealthReport {
  readonly available: boolean;
  readonly reason?: string;
}

export interface AgentContext {
  readonly agentId: string;
  readonly orgId: string;
  readonly runId: string;
  /** Grants as loaded at session build time; used only to decide which tools to expose. */
  readonly grants: readonly ToolGrant[];
  /** Reads current grants at execution time so a revoke takes effect mid-run. */
  readonly currentGrants: () => readonly ToolGrant[];
  /** What started this turn; server-owned, used for publication policy. */
  readonly trigger?: TurnTrigger;
}

export interface TurnTrigger {
  /** Conversation chain the turn's publications are charged to. */
  readonly chainId: string | null;
  /** Channels where a person (not an agent) messaged the agent in this turn. */
  readonly humanChannelIds: readonly string[];
  /** All channels the turn's input came from. */
  readonly channelIds: readonly string[];
}

export interface ToolResult {
  /** Short text returned to the model. Keep it well under ~2k tokens. */
  readonly text: string;
  readonly details?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface HiveTool<P extends TSchema = TSchema> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly access: ToolAccess;
  readonly parameters: P;
  execute(ctx: AgentContext, params: Static<P>, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * A tool with its parameter type erased, so packs can hold differently-typed tools in one list.
 * Parameters are validated against the schema by the runtime before execute is called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHiveTool = HiveTool<any>;

export interface Toolpack {
  readonly id: string;
  readonly label: string;
  /** Every tool the pack offers; the registry filters by grants. */
  tools(ctx: AgentContext): readonly AnyHiveTool[];
  readonly leases?: readonly LeaseKind[];
  healthcheck(): Promise<HealthReport>;
  /** Appended to the system prompt when the pack is active; keep it stable for prompt caching. */
  readonly guidance?: string;
}

export function defineHiveTool<P extends TSchema>(tool: HiveTool<P>): HiveTool<P> {
  return tool;
}

export function isGranted(grants: readonly ToolGrant[], toolpackId: string, toolName: string): boolean {
  return grants.some((g) => g.toolpackId === toolpackId && (g.toolName === "*" || g.toolName === toolName));
}
