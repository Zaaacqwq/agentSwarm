import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedTool } from "@hive/tools";
import type { ResolvedEndpoint } from "../../endpoints/endpoint-service.ts";
import { TurnError, type AgentRuntime, type RuntimeAgent, type RuntimeEvent, type TurnInput, type TurnResult } from "./agent-runtime.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_000;

type SessionFileEntries = Parameters<typeof SessionManager.inMemory>[2];

interface RegisteredEndpoint {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly models: ReadonlyMap<string, Model<Api>>;
}

/**
 * Runs one Pi turn per call. Each turn rebuilds the session from Hive's checkpoint,
 * so model, tool and prompt changes apply at the next turn boundary.
 * Nothing here reads ~/.pi: credentials, settings and resources are all supplied.
 */
export class PiRuntime implements AgentRuntime {
  private readonly endpoints = new Map<string, RegisteredEndpoint>();

  private constructor(
    private readonly models: ModelRuntime,
    private readonly piDir: string,
  ) {}

  static async create(dataDir: string): Promise<PiRuntime> {
    const piDir = join(dataDir, "pi");
    mkdirSync(join(piDir, "agents"), { recursive: true, mode: 0o700 });
    const authPath = join(piDir, "auth.json");
    if (!existsSync(authPath)) writeFileSync(authPath, "{}", { mode: 0o600 });
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      modelsStorePath: join(piDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return new PiRuntime(models, piDir);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    if (input.signal.aborted) throw input.signal.reason;
    const model = this.modelFor(input.endpoint, input.agent.modelId);
    const cwd = join(this.piDir, "agents", input.agent.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });

    const sessionManager = SessionManager.inMemory(cwd, undefined, (input.sessionEntries ?? undefined) as SessionFileEntries);
    const customTools = input.tools.map((t) => toPiTool(t, input));
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.piDir,
      modelRuntime: this.models,
      model,
      thinkingLevel: input.agent.thinkingLevel,
      resourceLoader: staticResources(buildSystemPrompt(input.agent, input.guidance)),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
      sessionManager,
      noTools: "all",
      // Pi enables nothing under noTools unless names are listed explicitly (P0 finding).
      tools: customTools.map((t) => t.name),
      customTools,
    });

    const unsubscribe = session.subscribe((event) => forward(event, input.onEvent));
    const onAbort = (): void => void session.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });
    const snapshot = (): unknown[] => {
      const header = sessionManager.getHeader();
      return [...(header ? [header] : []), ...sessionManager.getEntries()];
    };
    try {
      await session.prompt(input.prompt);
      if (input.signal.aborted) throw input.signal.reason;
      const failure = lastFailure(session);
      if (failure) throw new Error(failure);
      return { sessionEntries: snapshot() };
    } catch (error) {
      // Keep what the turn already did (the prompt, any replies) so the next turn remembers it.
      throw new TurnError(error instanceof Error ? error.message : String(error), snapshot());
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  }

  /** Registers (or refreshes) one Pi provider per Hive endpoint and returns the model. */
  private modelFor(endpoint: ResolvedEndpoint, modelId: string): Model<Api> {
    const providerId = `hive-${endpoint.id}`;
    const known = this.endpoints.get(endpoint.id);
    const sameConfig = known && known.apiKey === endpoint.apiKey && known.baseUrl === endpoint.baseUrl;
    const existing = sameConfig ? known.models.get(modelId) : undefined;
    if (existing) return existing;

    const models = new Map(sameConfig ? known.models : []);
    models.set(modelId, this.describeModel(providerId, endpoint, modelId));
    this.models.registerProvider(providerId, {
      name: providerId,
      baseUrl: endpoint.baseUrl,
      apiKey: escapeConfigValue(endpoint.apiKey),
      api: "openai-completions",
      models: [...models.values()].map(({ provider: _p, api: _a, baseUrl: _b, ...rest }) => rest),
    });
    this.endpoints.set(endpoint.id, { apiKey: endpoint.apiKey, baseUrl: endpoint.baseUrl, models });
    const registered = this.models.getModel(providerId, modelId);
    if (!registered) throw new Error(`Model ${modelId} could not be registered for endpoint ${endpoint.id}`);
    return registered;
  }

  /** Borrows pricing and limits from Pi's catalog when it knows the model, so costs are metered. */
  private describeModel(providerId: string, endpoint: ResolvedEndpoint, modelId: string): Model<Api> {
    const catalog = endpoint.kind === "openrouter" ? this.models.getModel("openrouter", modelId) : undefined;
    return {
      id: modelId,
      name: catalog?.name ?? modelId,
      api: "openai-completions",
      provider: providerId,
      baseUrl: endpoint.baseUrl,
      reasoning: catalog?.reasoning ?? false,
      input: catalog?.input ?? ["text"],
      cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: catalog?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(catalog?.thinkingLevelMap ? { thinkingLevelMap: catalog.thinkingLevelMap } : {}),
    } as Model<Api>;
  }
}

/**
 * Pi treats leading "!" as a shell command and "$NAME" as an env lookup in apiKey.
 * Escape both so a stored key is always used literally and can never execute anything.
 */
export function escapeConfigValue(value: string): string {
  const dollars = value.replaceAll("$", "$$$$");
  return dollars.startsWith("!") ? `$${dollars}` : dollars;
}

function toPiTool(resolved: ResolvedTool, input: TurnInput): ToolDefinition {
  const { tool } = resolved;
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await tool.execute(input.context, params, signal ?? input.signal);
      // Pi marks a tool result as failed when execute throws.
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  }) as ToolDefinition;
}

function staticResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function forward(event: AgentSessionEvent, emit: (e: RuntimeEvent) => void): void {
  switch (event.type) {
    case "message_end": {
      const message = event.message as Partial<AssistantMessage>;
      if (message.role !== "assistant") return;
      const assistant = message as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === "text" && block.text.trim()) emit({ kind: "assistant_text", text: block.text });
        if (block.type === "thinking" && block.thinking.trim()) emit({ kind: "thinking", text: block.thinking });
      }
      const u = assistant.usage;
      if (u && (u.input > 0 || u.output > 0)) {
        emit({
          kind: "usage",
          provider: assistant.provider,
          model: assistant.responseModel ?? assistant.model,
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
          costUsd: u.cost?.total ?? 0,
        });
      }
      return;
    }
    case "tool_execution_start":
      emit({ kind: "tool_call", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
      return;
    case "tool_execution_end":
      emit({ kind: "tool_result", toolCallId: event.toolCallId, name: event.toolName, isError: event.isError, text: resultText(event.result) });
      return;
    case "auto_retry_start":
      emit({ kind: "notice", text: `Retrying model call (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}` });
      return;
    case "compaction_end":
      if (event.result) emit({ kind: "notice", text: `Context compacted (${event.reason}).` });
      return;
    default:
      return;
  }
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function lastFailure(session: AgentSession): string | null {
  const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as AssistantMessage | undefined;
  if (last?.stopReason === "error") return last.errorMessage ?? "Model call failed";
  return null;
}

export type { RuntimeAgent };
