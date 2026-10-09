/** What we learn about a model that Pi's built-in catalog does not know. */
export interface ModelFacts {
  readonly input: readonly ("text" | "image")[];
  /** USD per million tokens. */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

interface OpenRouterModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  top_provider?: { max_completion_tokens?: number | null };
}

const TTL_MS = 6 * 60 * 60 * 1000;
const perMillion = (v: string | undefined): number => (v ? Number(v) * 1_000_000 || 0 : 0);

/**
 * OpenRouter's public model list (no key needed): input modalities and prices, so vision models
 * receive screenshots and costs are metered. Failures leave the model text-only and unpriced.
 */
export class OpenRouterCatalog {
  private cache = new Map<string, { at: number; models: Map<string, ModelFacts> }>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async facts(baseUrl: string, modelId: string): Promise<ModelFacts | null> {
    const key = baseUrl.replace(/\/+$/, "");
    let entry = this.cache.get(key);
    if (!entry || Date.now() - entry.at > TTL_MS) {
      const models = await this.load(key);
      if (!models) return entry?.models.get(modelId) ?? null;
      entry = { at: Date.now(), models };
      this.cache.set(key, entry);
    }
    return entry.models.get(modelId) ?? null;
  }

  private async load(baseUrl: string): Promise<Map<string, ModelFacts> | null> {
    try {
      const res = await this.fetcher(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: OpenRouterModel[] };
      const out = new Map<string, ModelFacts>();
      for (const m of body.data ?? []) {
        const modalities = m.architecture?.input_modalities ?? ["text"];
        out.set(m.id, {
          input: modalities.includes("image") ? ["text", "image"] : ["text"],
          cost: { input: perMillion(m.pricing?.prompt), output: perMillion(m.pricing?.completion), cacheRead: perMillion(m.pricing?.input_cache_read), cacheWrite: perMillion(m.pricing?.input_cache_write) },
          ...(m.context_length ? { contextWindow: m.context_length } : {}),
          ...(m.top_provider?.max_completion_tokens ? { maxTokens: m.top_provider.max_completion_tokens } : {}),
        });
      }
      return out;
    } catch {
      return null;
    }
  }
}
