import type {
  ActivityEvent, Agent, Channel, CreateAgent, CreateEndpoint, Credentials, Endpoint, Message, MessagePage,
  Run, SessionInfo, ToolpackInfo, UpdateAgent, UpdateEndpoint, UsageSummary,
} from "@hive/core";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "http_error", err.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const api = {
  session: () => request<SessionInfo>("GET", "/auth/session"),
  setup: (c: Credentials) => request<SessionInfo>("POST", "/auth/setup", c),
  login: (c: Credentials) => request<SessionInfo>("POST", "/auth/login", c),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),

  endpoints: () => request<Endpoint[]>("GET", "/endpoints"),
  createEndpoint: (e: CreateEndpoint) => request<Endpoint>("POST", "/endpoints", e),
  updateEndpoint: (id: string, e: UpdateEndpoint) => request<Endpoint>("PATCH", `/endpoints/${id}`, e),
  deleteEndpoint: (id: string) => request<{ ok: true }>("DELETE", `/endpoints/${id}`),

  toolpacks: () => request<ToolpackInfo[]>("GET", "/toolpacks"),
  usage: () => request<UsageSummary>("GET", "/usage"),

  agents: () => request<Agent[]>("GET", "/agents"),
  createAgent: (a: CreateAgent) => request<Agent>("POST", "/agents", a),
  updateAgent: (id: string, a: UpdateAgent) => request<Agent>("PATCH", `/agents/${id}`, a),
  deleteAgent: (id: string) => request<{ ok: true }>("DELETE", `/agents/${id}`),
  stopAgent: (id: string) => request<{ stopped: boolean }>("POST", `/agents/${id}/stop`),
  agentRuns: (id: string) => request<{ runs: Run[]; activity: ActivityEvent[] }>("GET", `/agents/${id}/runs?limit=15`),
  agentUsage: (id: string) => request<UsageSummary>("GET", `/agents/${id}/usage`),

  channels: () => request<Channel[]>("GET", "/channels"),
  openDm: (agentId: string) => request<Channel>("POST", "/channels/dm", { agentId }),
  messages: (channelId: string, before?: number) =>
    request<MessagePage>("GET", `/channels/${channelId}/messages${before ? `?before=${before}` : ""}`),
  postMessage: (channelId: string, body: string) => request<Message>("POST", `/channels/${channelId}/messages`, { body }),
};

export const qk = {
  session: ["session"] as const,
  endpoints: ["endpoints"] as const,
  toolpacks: ["toolpacks"] as const,
  usage: ["usage"] as const,
  agents: ["agents"] as const,
  agentRuns: (id: string) => ["agent-runs", id] as const,
  agentUsage: (id: string) => ["agent-usage", id] as const,
  channels: ["channels"] as const,
  messages: (channelId: string) => ["messages", channelId] as const,
};
