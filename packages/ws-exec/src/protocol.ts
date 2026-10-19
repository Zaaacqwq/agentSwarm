/** One JSON request on stdin, one JSON response on stdout, per ws-exec process. */
export type Request =
  | { op: "info" }
  | { op: "fs.list"; scope: string; path: string; depth?: number }
  | { op: "fs.read"; scope: string; path: string; offset?: number; limit?: number }
  | { op: "fs.write"; scope: string; path: string; content: string; encoding?: "utf8" | "base64"; append?: boolean }
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
  | { op: "reap" }
  // R6: this workstation's own simulator device (agentswarm-<user>); a request never names a device.
  | { op: "sim.boot"; scope: string; deviceType?: string; runtime?: string }
  | { op: "sim.build"; scope: string; project?: string; workspace?: string; scheme: string; configuration?: string; timeoutMs?: number }
  | { op: "sim.launch"; scope: string; bundleId: string; args?: string[] }
  | { op: "sim.ui"; scope: string }
  | { op: "sim.tap"; scope: string; x: number; y: number }
  | { op: "sim.type"; scope: string; text: string }
  | { op: "sim.swipe"; scope: string; from: [number, number]; to: [number, number]; durationS?: number }
  | { op: "sim.button"; scope: string; button: string }
  | { op: "sim.screenshot"; scope: string; saveAs?: string; region?: [number, number, number, number] }
  | { op: "sim.logs"; scope: string; process?: string; seconds?: number }
  | { op: "sim.shutdown"; scope: string }
  /** R9: build the macOS app (unsigned) and return it packed, for swarmd to open on the desktop. */
  | { op: "mac.build"; scope: string; project?: string; workspace?: string; scheme: string; configuration?: string; timeoutMs?: number }
  /**
   * A headless browser for the run (R6). After this request, swarmd writes browser commands as lines
   * (`{"id": 1, "cmd": "open", "url": …}`); each reply is an event. Ends when swarmd closes stdin.
   */
  | { op: "browser.session"; scope: string; interact?: string[]; timeoutMs: number };

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

/** A screenshot as a model sees it: a JPEG (base64), longest side 1000 px, and the size it was taken at. */
export interface ImageResult {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** When it is a closer look: which part of the screen, [x1, y1, x2, y2] in 0–1000. */
  readonly region?: readonly [number, number, number, number];
  /** Where the evidence copy went (relative to the worktree), when asked. */
  readonly saved?: string;
}

export interface SimDevice {
  readonly udid: string;
  readonly name: string;
  readonly deviceType: string;
  readonly runtime: string;
  readonly bootMs: number;
}

/** R9: a macOS build. `archive` is the .app as a gzipped tar (base64), for swarmd to check, sign and open. */
export interface MacBuildResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly durationMs: number;
  readonly app: string | null;
  readonly bundleId: string | null;
  readonly archive: string | null;
}

export interface SimBuildResult {
  readonly ok: boolean;
  /** The error lines, at most 40. */
  readonly errors: readonly string[];
  readonly durationMs: number;
  readonly bundleId: string | null;
  readonly app: string | null;
}

/** One accessibility element: frame is [x, y, width, height] in screen points. */
export interface UiElement {
  readonly type: string;
  readonly label?: string;
  readonly value?: string;
  readonly id?: string;
  readonly enabled?: false;
  readonly frame: readonly [number, number, number, number];
  readonly children?: readonly UiElement[];
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}
