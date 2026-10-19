/** Small fetch wrapper: JSON in and out, errors carry the server's message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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

/** A picture as itself (R7): the server checks its bytes, converts it and answers JSON. */
export async function upload<T>(path: string, file: Blob, name: string, raw = false): Promise<T> {
  // A picture says what it is; anything else (R10 files) goes as bytes and is checked by swarmd.
  const type = !raw && /^image\/(jpeg|png|heic|heif)$/.test(file.type) ? file.type : "application/octet-stream";
  const res = await fetch(`/api${path}?name=${encodeURIComponent(name)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": type }, body: file });
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

/** A future moment, relative: "in 40 min", "in 3 h", "in 2 days". */
export const until = (ms: number) => {
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 120) return `in ${mins} min`;
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} days`;
};
