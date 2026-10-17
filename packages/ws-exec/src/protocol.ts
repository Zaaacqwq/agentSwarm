/** One JSON request on stdin, one JSON response on stdout, per ws-exec process. */
export type Request =
  | { op: "info" }
  | { op: "fs.list"; scope: string; path: string; depth?: number }
  | { op: "fs.read"; scope: string; path: string; offset?: number; limit?: number }
  | { op: "fs.write"; scope: string; path: string; content: string }
  | { op: "fs.edit"; scope: string; path: string; oldText: string; newText: string; replaceAll?: boolean }
  | { op: "fs.grep"; scope: string; pattern: string; path?: string; glob?: string; maxResults?: number }
  | { op: "exec"; scope: string; command: string; timeoutMs?: number }
  /** `files`: the project's local files (not in git) written into the worktree and excluded from commits (R5). */
  | { op: "git.clone"; scope: string; mirror: string; branch: string; base: string; files?: readonly { path: string; content: string }[] }
  | { op: "git.status"; scope: string }
  | { op: "git.commit"; scope: string; message: string }
  | { op: "git.pushInbox"; scope: string; branch: string }
  | { op: "git.remove"; scope: string }
  /** Merge another hive branch from the mirror into this worktree (no fast-forward); aborts on conflict. */
  | { op: "git.merge"; scope: string; branch: string; sha: string; message: string }
  /** Run a CLI worker in a worktree; streams its events as `{"event": …}` lines before the response (R4). */
  | { op: "cli.run"; scope: string; runtime: CliRuntime; prompt: string; resume?: string; model?: string; maxTurns: number; timeoutMs: number; credential?: string; output?: "report" | "review" }
  /** Codex device-code sign-in for this workstation; streams the lines Codex prints (the URL and code). */
  | { op: "cli.login"; runtime: "codex" }
  | { op: "cli.logout"; runtime: "codex" }
  /** Installed versions, and whether Codex is signed in on this workstation. */
  | { op: "cli.status" }
  /** Kill every process of this workstation user: the run ended, was cancelled, or swarmd restarted. */
  | { op: "reap" };

export type Op = Request["op"];

export const CLI_RUNTIMES = ["claude_code", "codex"] as const;
export type CliRuntime = (typeof CLI_RUNTIMES)[number];

/** A line a streaming op writes before its response. */
export interface StreamLine {
  readonly event: unknown;
}

export interface CliRunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Set when ws-exec stopped the CLI itself (Codex has no turn limit of its own). */
  readonly stoppedFor: "turns" | null;
  /** The tail of what the CLI wrote to stderr. */
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CliStatus {
  readonly claude: string | null;
  readonly codex: string | null;
  /** null: the check gave no clear answer (a timeout, a crash). */
  readonly codexSignedIn: boolean | null;
}

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
