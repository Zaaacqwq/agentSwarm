import type { EndpointService } from "../endpoints/endpoint-service.ts";
import { FETCH_LIMITS, fetchPage, type FetchedPage } from "./web-fetch.ts";

export interface SearchResult {
  readonly text: string;
  readonly costUsd: number;
}

/** What research agents can do on the web. swarmd does it for them; workstations stay offline. */
export interface WebAccess {
  fetch(url: string, signal?: AbortSignal): Promise<FetchedPage>;
  /** Null when the agent's endpoint cannot search (only OpenRouter can). */
  search(query: string, agent: { endpointId: string; modelId: string }, signal?: AbortSignal): Promise<SearchResult | null>;
}

/** Exa through OpenRouter's web plugin: $0.007 per request for up to 10 results (checked 2026-10-17). */
export const SEARCH_PRICE_USD = 0.007;
const MAX_RESULTS = 6;

interface Completion {
  choices?: { message?: { content?: string; annotations?: { type: string; url_citation?: { url: string; title?: string; content?: string } }[] } }[];
  usage?: { cost?: number };
}

export function createWebAccess(endpoints: EndpointService): WebAccess {
  return {
    fetch: (url, signal) => fetchPage(url, signal),
    async search(query, agent, signal) {
      const endpoint = await endpoints.secret(agent.endpointId);
      if (endpoint.kind !== "openrouter" || !endpoint.apiKey) return null;
      const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: agent.modelId,
          messages: [{ role: "user", content: `Search the web for: ${query}\n\nList what the most relevant results say, one short paragraph each, with their URLs.` }],
          plugins: [{ id: "web", engine: "exa", max_results: MAX_RESULTS }],
          max_tokens: 1200,
          usage: { include: true },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Web search failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as Completion;
      return { text: formatSearch(body), costUsd: body.usage?.cost ?? SEARCH_PRICE_USD };
    },
  };
}

export function formatSearch(body: Completion): string {
  const message = body.choices?.[0]?.message;
  const sources = (message?.annotations ?? []).filter((a) => a.type === "url_citation" && a.url_citation).map((a) => a.url_citation!);
  const seen = new Set<string>();
  const list = sources.filter((s) => !seen.has(s.url) && seen.add(s.url)).map((s, i) =>
    `${i + 1}. ${s.title?.trim() || s.url}\n   ${s.url}${s.content ? `\n   ${s.content.replace(/\s+/g, " ").trim().slice(0, 500)}` : ""}`);
  return [list.length ? `Results:\n${list.join("\n")}` : "No results.", message?.content?.trim() ? `\nSummary:\n${message.content.trim()}` : ""].join("\n").trim();
}

/** A window of a long page, so agents can read on with offset. */
export function pageWindow(page: FetchedPage, offset = 0, maxChars: number = FETCH_LIMITS.maxChars): string {
  const slice = page.text.slice(offset, offset + maxChars);
  const more = offset + maxChars < page.text.length;
  return [
    `${page.title ? `${page.title}\n` : ""}${page.url} (HTTP ${page.status}, ${page.text.length} characters${offset ? `, from ${offset}` : ""})`,
    "",
    slice || "(no text)",
    more ? `\n… ${page.text.length - offset - maxChars} more characters; call web_fetch again with offset ${offset + maxChars}` : "",
  ].join("\n");
}
