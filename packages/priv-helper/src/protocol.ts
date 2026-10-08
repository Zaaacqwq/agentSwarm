/** JSON request/response between hived and hive-exec (one request per process, over stdin/stdout). */

export type Request =
  | { op: "fs.list"; scope: string; path: string; depth?: number }
  | { op: "fs.read"; scope: string; path: string; offset?: number; limit?: number }
  | { op: "fs.write"; scope: string; path: string; content: string }
  | { op: "fs.edit"; scope: string; path: string; oldText: string; newText: string; replaceAll?: boolean }
  | { op: "fs.grep"; scope: string; pattern: string; path?: string; glob?: string; maxResults?: number }
  | { op: "exec"; scope: string; command: string; timeoutMs?: number }
  | { op: "tmux.create"; scope: string; name: string }
  | { op: "tmux.send"; name: string; keys: string; enter?: boolean }
  | { op: "tmux.read"; name: string; lines?: number }
  | { op: "tmux.kill"; name: string }
  | { op: "tmux.list" }
  | { op: "git.clone"; scope: string; mirror: string; branch: string; base: string }
  | { op: "git.status"; scope: string }
  | { op: "git.commit"; scope: string; message: string }
  | { op: "git.pushInbox"; scope: string; branch: string }
  | { op: "git.remove"; scope: string }
  | { op: "info" };

export type Response = { ok: true; result: unknown } | { ok: false; error: string; code: ErrorCode };

export type ErrorCode = "bad_request" | "out_of_scope" | "not_found" | "conflict" | "timeout" | "failed";

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}
