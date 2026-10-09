import type {
  ActivityEvent, Agent, Channel, CreateAgent, CreateEndpoint, Credentials, Endpoint, Message, MessagePage,
  Run, SessionInfo, ToolpackInfo, UpdateAgent, UpdateEndpoint, UsageSummary,
  CreateWorkstation, GitPush, HostStatus, Repository, Terminal, Workstation, Worktree,
  QueueInfo, SearchHit, UpdateGroup,
} from "@hive/core";

export type QueueMap = Record<string, QueueInfo | undefined>;

export interface RunSource {
  readonly messageId: number;
  readonly authorName: string;
  readonly authorKind: string;
  readonly channelId: string;
  readonly channelTitle: string;
}

export type FileView =
  | { kind: "dir"; entries: string[]; truncated: boolean }
  | { kind: "file"; path: string; content: string; fromLine: number; totalLines: number; truncated: boolean };

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
  agentRuns: (id: string) => request<{ runs: Run[]; activity: ActivityEvent[]; sources: Record<string, RunSource[]> }>("GET", `/agents/${id}/runs?limit=15`),
  agentUsage: (id: string) => request<UsageSummary>("GET", `/agents/${id}/usage`),

  channels: () => request<Channel[]>("GET", "/channels"),
  openDm: (agentId: string) => request<Channel>("POST", "/channels/dm", { agentId }),
  messages: (channelId: string, opts: { before?: number; around?: number } = {}) => {
    const q = opts.before ? `?before=${opts.before}` : opts.around ? `?around=${opts.around}&limit=80` : "";
    return request<MessagePage>("GET", `/channels/${channelId}/messages${q}`);
  },
  postMessage: (channelId: string, body: string, replyToId?: number) =>
    request<Message>("POST", `/channels/${channelId}/messages`, replyToId ? { body, replyToId } : { body }),
  createGroup: (title: string, agentIds: string[]) => request<Channel>("POST", "/channels/groups", { title, agentIds }),
  updateGroup: (id: string, input: UpdateGroup) => request<Channel>("PATCH", `/channels/${id}`, input),
  deleteGroup: (id: string) => request<{ ok: true }>("DELETE", `/channels/${id}`),
  react: (messageId: number, emoji: string, add: boolean) => request<Message>(add ? "PUT" : "DELETE", `/messages/${messageId}/reactions`, { emoji }),
  search: (q: string, channelId?: string) =>
    request<SearchHit[]>("GET", `/search?q=${encodeURIComponent(q)}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ""}&limit=25`),

  workstations: () => request<Workstation[]>("GET", "/workstations"),
  createWorkstation: (w: CreateWorkstation) => request<Workstation>("POST", "/workstations", w),
  deleteWorkstation: (id: string) => request<{ ok: true }>("DELETE", `/workstations/${id}`),
  worktrees: (id: string) => request<Worktree[]>("GET", `/workstations/${id}/worktrees`),
  terminals: (id: string) => request<Terminal[]>("GET", `/workstations/${id}/terminals`),
  terminal: (id: string, name: string) => request<{ output: string }>("GET", `/workstations/${id}/terminals/${encodeURIComponent(name)}`),
  files: (id: string, worktreeId: string, path: string) =>
    request<FileView>("GET", `/workstations/${id}/files?worktreeId=${encodeURIComponent(worktreeId)}&path=${encodeURIComponent(path)}`),
  bindWorkstation: (agentId: string, workstationId: string | null) => request<{ ok: true }>("PUT", `/agents/${agentId}/workstation`, { workstationId }),
  pushes: (agentId: string) => request<GitPush[]>("GET", `/agents/${agentId}/pushes`),
  repositories: () => request<Repository[]>("GET", "/repositories"),
  createRepository: (githubFullName: string) => request<Repository>("POST", "/repositories", { githubFullName }),
  refreshRepository: (id: string) => request<{ ok: true }>("POST", `/repositories/${id}/refresh`),
  deleteRepository: (id: string) => request<{ ok: true }>("DELETE", `/repositories/${id}`),
  host: () => request<HostStatus>("GET", "/host"),
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
  workstations: ["workstations"] as const,
  worktrees: (id: string) => ["worktrees", id] as const,
  terminals: (id: string) => ["terminals", id] as const,
  terminal: (id: string, name: string) => ["terminal", id, name] as const,
  files: (id: string, worktreeId: string, path: string) => ["files", id, worktreeId, path] as const,
  pushes: (agentId: string) => ["pushes", agentId] as const,
  repositories: ["repositories"] as const,
  host: ["host"] as const,
  queue: ["agent-queue"] as const,
  search: (q: string) => ["search", q] as const,
};
