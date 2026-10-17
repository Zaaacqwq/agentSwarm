/** One JSON request on stdin, one JSON response on stdout, per ws-exec process. */
export type Request =
  | { op: "info" }
  | { op: "fs.list"; scope: string; path: string; depth?: number }
  | { op: "fs.read"; scope: string; path: string; offset?: number; limit?: number }
  | { op: "fs.write"; scope: string; path: string; content: string }
  | { op: "fs.edit"; scope: string; path: string; oldText: string; newText: string; replaceAll?: boolean }
  | { op: "fs.grep"; scope: string; pattern: string; path?: string; glob?: string; maxResults?: number }
  | { op: "exec"; scope: string; command: string; timeoutMs?: number }
  | { op: "git.clone"; scope: string; mirror: string; branch: string; base: string }
  | { op: "git.status"; scope: string }
  | { op: "git.commit"; scope: string; message: string }
  | { op: "git.pushInbox"; scope: string; branch: string }
  | { op: "git.remove"; scope: string }
  /** Kill every process of this workstation user: the run ended, was cancelled, or hived restarted. */
  | { op: "reap" };

export type Op = Request["op"];

export type ErrorCode = "bad_request" | "out_of_scope" | "not_found" | "conflict" | "timeout" | "failed";

export type Response = { ok: true; result: unknown } | { ok: false; code: ErrorCode; error: string };

export class OpError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}
