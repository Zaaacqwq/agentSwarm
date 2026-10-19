import type { ModelView } from "@agentswarm/contracts";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { EndpointSecret, EndpointService } from "../endpoints/endpoint-service.ts";
import { badRequest } from "../errors.ts";

export interface ResolvedModel {
  readonly model: Model<any>;
  /** Streams one model request; the endpoint's key and a per-request timeout are applied inside. */
  readonly streamFn: StreamFn;
}

export interface ModelGateway {
  listModels(endpointId: string): Promise<ModelView[]>;
  resolve(endpointId: string, modelId: string): Promise<ResolvedModel>;
}

/** A model request still running after this long is cut off and retried (R0 saw multi-minute stalls). */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;
const LIST_TTL_MS = 10 * 60 * 1000;

interface Collection {
  readonly models: Models;
  readonly providerId: string;
  loadedAt: number;
}

/** Real endpoints through Pi: OpenRouter's live model list, or an OpenAI-compatible server's /models. */
export class PiModelGateway implements ModelGateway {
  private readonly endpoints: EndpointService;
  private readonly collections = new Map<string, Collection>();

  constructor(endpoints: EndpointService) {
    this.endpoints = endpoints;
  }

  async listModels(endpointId: string): Promise<ModelView[]> {
    const { collection } = await this.load(endpointId);
    return collection.models.getModels(collection.providerId).map(toView);
  }

  async resolve(endpointId: string, modelId: string): Promise<ResolvedModel> {
    const { collection, secret } = await this.load(endpointId);
    const model = collection.models.getModel(collection.providerId, modelId);
    if (!model) throw badRequest(`Model ${modelId} is not offered by this endpoint`);
    const models = collection.models;
    const streamFn: StreamFn = (m, context, options) => {
      const timeout = AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      return models.streamSimple(m, context, { ...options, signal, ...(secret.apiKey ? { apiKey: secret.apiKey } : {}) });
    };
    return { model, streamFn };
  }

  /** Forget a cached list (an endpoint was deleted or its key changed). */
  forget(endpointId: string): void {
    this.collections.delete(endpointId);
  }

  private async load(endpointId: string): Promise<{ collection: Collection; secret: EndpointSecret }> {
    const secret = await this.endpoints.secret(endpointId);
    let collection = this.collections.get(endpointId);
    if (!collection) {
      collection = secret.kind === "openrouter" ? openRouter() : await openAICompatible(secret);
      this.collections.set(endpointId, collection);
    }
    if (Date.now() - collection.loadedAt > LIST_TTL_MS) {
      if (secret.kind === "openrouter") await collection.models.refresh({ providers: [collection.providerId] });
      else this.collections.set(endpointId, (collection = await openAICompatible(secret)));
      collection.loadedAt = Date.now();
    }
    return { collection, secret };
  }
}

function openRouter(): Collection {
  const models = createModels();
  const provider = openrouterProvider();
  models.setProvider(provider);
  return { models, providerId: "openrouter", loadedAt: 0 };
}

async function openAICompatible(secret: EndpointSecret): Promise<Collection> {
  const res = await fetch(`${secret.baseUrl}/models`, {
    headers: secret.apiKey ? { authorization: `Bearer ${secret.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw badRequest(`${secret.baseUrl}/models answered ${res.status}`);
  const body = (await res.json()) as { data?: { id: string }[] };
  const providerId = `agentswarm-${secret.id}`;
  const list: Model<"openai-completions">[] = (body.data ?? []).map((m) => ({
    id: m.id,
    name: m.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl: secret.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  }));
  const models = createModels();
  models.setProvider(createProvider({
    id: providerId,
    name: providerId,
    baseUrl: secret.baseUrl,
    auth: { apiKey: { name: providerId, resolve: async () => ({ auth: {} }) } },
    models: list,
    api: openAICompletionsApi(),
  }));
  return { models, providerId, loadedAt: Date.now() };
}

function toView(m: Model<any>): ModelView {
  return {
    id: m.id,
    name: m.name ?? m.id,
    vision: (m.input ?? []).includes("image"),
    contextWindow: m.contextWindow ?? 0,
    inputPerMTok: m.cost?.input ?? 0,
    outputPerMTok: m.cost?.output ?? 0,
  };
}
