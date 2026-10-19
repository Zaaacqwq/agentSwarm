/** Small fetch wrapper: JSON in and out, errors carry the server's message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  return data as T;
}

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
export const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
export const ago = (ms: number | null) => {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
};
