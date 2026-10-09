import type { AgentRuntime, RuntimeEvent, TurnInput, TurnResult } from "../src/agents/runtime/agent-runtime.ts";
import { SecretBox } from "../src/crypto/secret-box.ts";
import { createServices } from "../src/app/services.ts";
import type { ManagerLimits } from "../src/agents/agent-manager.ts";
import { COMMUNICATION_PACK_ID } from "@hive/tools";
import { ADMIN, memoryDb } from "./helpers.ts";
import { localBackend } from "./local-backend.ts";
import type { WorkstationBackend } from "../src/workstations/backend.ts";
import type { GitHubPort } from "../src/git-relay/github.ts";

export type Script = (input: TurnInput) => Promise<void>;

/** Stands in for Pi: runs a script per turn and drives the real tools it was given. */
export class ScriptedRuntime implements AgentRuntime {
  readonly calls: TurnInput[] = [];
  constructor(public script: Script = async () => {}) {}

  async runTurn(input: TurnInput): Promise<TurnResult> {
    this.calls.push(input);
    await this.script(input);
    return { sessionEntries: [...(input.sessionEntries ?? []), { prompt: input.prompt }] };
  }
}

export async function callTool(input: TurnInput, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const resolved = input.tools.find((t) => t.tool.name === name);
  const toolCallId = `call_${Math.random().toString(36).slice(2)}`;
  input.onEvent({ kind: "tool_call", toolCallId, name, args });
  if (!resolved) {
    input.onEvent({ kind: "tool_result", toolCallId, name, isError: true, text: "Tool not found" });
    return { text: "Tool not found", isError: true };
  }
  const result = await resolved.tool.execute(input.context, args, input.signal);
  input.onEvent({ kind: "tool_result", toolCallId, name, isError: !!result.isError, text: result.text });
  return { text: result.text, isError: !!result.isError };
}

export function channelOf(input: TurnInput): string {
  const match = /channel_id=(ch_[a-z0-9]+)/.exec(input.prompt);
  if (!match?.[1]) throw new Error("no channel in prompt");
  return match[1];
}

export const usage = (costUsd = 0.001): RuntimeEvent => ({
  kind: "usage", provider: "test", model: "fake-1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd,
});

export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export const COMMS_GRANT = [{ toolpackId: COMMUNICATION_PACK_ID, toolName: "*" }];

export interface WorldOptions {
  readonly script?: Script;
  readonly limits?: Partial<ManagerLimits>;
  readonly dbPath?: string;
  readonly runtime?: AgentRuntime;
  readonly endpoint?: { kind: "openrouter" | "openai-compatible"; baseUrl?: string; apiKey: string };
  readonly backend?: WorkstationBackend;
  readonly github?: GitHubPort;
  readonly leaseWaitMs?: number;
}

export async function buildWorld(opts: WorldOptions = {}) {
  const handle = opts.dbPath ? (await import("../src/db/client.ts")).openDatabase(opts.dbPath) : memoryDb();
  const secrets = await SecretBox.fromRawKey(new Uint8Array(32).fill(9));
  const runtime = new ScriptedRuntime(opts.script);
  const activeRuntime = opts.runtime ?? runtime;
  const logs: { level: string; msg: string }[] = [];
  const services = createServices({
    db: handle.db,
    secrets,
    runtime: activeRuntime,
    backend: opts.backend ?? localBackend().backend,
    hostProbe: { pressureLevel: () => "normal", swapUsedMb: () => 0, disk: () => ({ freeGb: 100, totalGb: 200 }) },
    ...(opts.github ? { github: opts.github } : {}),
    log: (level, msg) => logs.push({ level, msg }),
    // Tests drive timing explicitly: no debounce unless a test asks for it.
    limits: { debounceMs: 0, ...opts.limits },
    leaseWaitMs: opts.leaseWaitMs ?? 50,
  });
  await services.start();
  const setupRequired = services.auth.isSetupRequired();
  const session = setupRequired ? await services.auth.setupAdmin(ADMIN) : await services.auth.login(ADMIN);
  const user = session.user;
  const endpoint = setupRequired
    ? await services.endpoints.create(user, { name: "Primary", ...(opts.endpoint ?? { kind: "openrouter", apiKey: "sk-or-test-key" }) })
    : services.endpoints.list(user)[0]!;
  const events: string[] = [];
  services.bus.subscribe(({ event }) => events.push(event.type));
  const makeAgent = (name: string, grants = COMMS_GRANT, modelId = "fake-1") =>
    services.agents.create(user, { name, role: "dev", instructions: "Be brief.", endpointId: endpoint.id, modelId, thinkingLevel: "off", grants });
  return { ...services, handle, runtime, user, token: session.token, endpoint, makeAgent, logs, events };
}
