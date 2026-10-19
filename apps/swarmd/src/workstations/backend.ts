import { spawn } from "node:child_process";
import type { ExecEnv, Request, Response } from "@agentswarm/ws-exec";
import { WS_USER_PATTERN } from "@agentswarm/ws-exec";

/**
 * Root-owned launcher: checks the workstation user, then runs ws-exec as that user inside the user's own
 * launchd session. Plain `sudo -u` would keep the owner's GUI session (clipboard, Apple Events, screen).
 */
export const WS_LAUNCH_PATH = "/usr/local/libexec/agentswarm/ws-launch";

export class WorkstationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Events a streaming op (cli.*) reports before its response, in order. */
  readonly onEvent?: (event: unknown) => void;
}

/** A request whose stdin stays open (browser.session, R6): commands go in as lines, replies come back as events. */
export interface WorkstationSession<T> {
  send(command: object): void;
  /** Ends stdin: ws-exec winds the session down and responds. */
  close(): void;
  readonly done: Promise<T>;
}

/** Runs one ws-exec request as a workstation user. */
export interface WorkstationBackend {
  call<T>(osUser: string, request: Request, opts?: CallOptions): Promise<T>;
  open<T>(osUser: string, request: Request, opts?: CallOptions): WorkstationSession<T>;
  /** The workstation users that exist on this machine. */
  listUsers(): Promise<string[]>;
}

/** Production: `sudo -n ws-launch ws-N`, allowed (for exactly those arguments) by the sudoers rule scripts/setup.sh writes. */
export class SudoBackend implements WorkstationBackend {
  private readonly launchPath: string;

  constructor(launchPath = WS_LAUNCH_PATH) {
    this.launchPath = launchPath;
  }

  call<T>(osUser: string, request: Request, opts: CallOptions = {}): Promise<T> {
    if (!WS_USER_PATTERN.test(osUser)) return Promise.reject(new WorkstationError("bad_request", `Not a workstation user: ${osUser}`));
    return runJson<T>(["/usr/bin/sudo", "-n", this.launchPath, osUser], { PATH: "/usr/bin:/bin" }, request, opts).done;
  }

  open<T>(osUser: string, request: Request, opts: CallOptions = {}): WorkstationSession<T> {
    if (!WS_USER_PATTERN.test(osUser)) return closedSession(new WorkstationError("bad_request", `Not a workstation user: ${osUser}`));
    return runJson<T>(["/usr/bin/sudo", "-n", this.launchPath, osUser], { PATH: "/usr/bin:/bin" }, request, opts, true);
  }

  async listUsers(): Promise<string[]> {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("/usr/bin/dscl", [".", "-list", "/Users"], { stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      child.stdout.on("data", (b: Buffer) => (text += b.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    return out.split("\n").map((s) => s.trim()).filter((u) => WS_USER_PATTERN.test(u)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  }
}

/** Tests: ws-exec's dispatcher in a child process with a temp layout, no sudo. */
export class LocalBackend implements WorkstationBackend {
  private readonly envs: Map<string, ExecEnv>;
  private readonly entry: string;

  constructor(envs: Map<string, ExecEnv>, entry: string) {
    this.envs = envs;
    this.entry = entry;
  }

  call<T>(osUser: string, request: Request, opts: CallOptions = {}): Promise<T> {
    const env = this.envs.get(osUser);
    if (!env) return Promise.reject(new WorkstationError("bad_request", `Not a workstation user: ${osUser}`));
    return runJson<T>([process.execPath, this.entry], { PATH: "/usr/bin:/bin", WS_EXEC_TEST_ENV: JSON.stringify(env) }, request, opts).done;
  }

  open<T>(osUser: string, request: Request, opts: CallOptions = {}): WorkstationSession<T> {
    const env = this.envs.get(osUser);
    if (!env) return closedSession(new WorkstationError("bad_request", `Not a workstation user: ${osUser}`));
    return runJson<T>([process.execPath, this.entry], { PATH: "/usr/bin:/bin", WS_EXEC_TEST_ENV: JSON.stringify(env) }, request, opts, true);
  }

  async listUsers(): Promise<string[]> {
    return [...this.envs.keys()];
  }
}

function closedSession<T>(error: Error): WorkstationSession<T> {
  const done = Promise.reject(error);
  done.catch(() => undefined);
  return { send: () => undefined, close: () => undefined, done };
}

/** One ws-exec process. With `keepOpen`, stdin stays open after the request for a session's commands. */
function runJson<T>(argv: string[], env: Record<string, string>, request: Request, opts: CallOptions, keepOpen = false): WorkstationSession<T> {
  const [cmd, ...args] = argv as [string, ...string[]];
  let input: NodeJS.WritableStream | null = null;
  const done = new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new WorkstationError("cancelled", "Cancelled"));
    const child = spawn(cmd, args, { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    // Lines are read as they come: `{"event": …}` lines go to onEvent, the last line is the response.
    let pending = "";
    let last = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    // The first error thrown by onEvent fails the call (after ws-exec ends), instead of vanishing.
    let handlerError: Error | null = null;
    const line = (text: string) => {
      if (!text.trim()) return;
      if (text.startsWith('{"event":')) {
        let event: unknown;
        try {
          event = (JSON.parse(text) as { event: unknown }).event;
        } catch {
          // A cut or garbled event line: skip it, the response still comes.
          return;
        }
        try {
          opts.onEvent?.(event);
        } catch (error) {
          handlerError ??= error as Error;
        }
        return;
      }
      last = text;
    };
    // sudo relays SIGTERM to ws-exec, which kills its commands' process groups.
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new WorkstationError("cancelled", "Cancelled")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new WorkstationError("timeout", "Workstation call timed out")));
    }, opts.timeoutMs ?? 660_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        line(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (b: Buffer) => (err = (err + b.toString("utf8")).slice(-4000)));
    child.on("error", (e) => finish(() => reject(new WorkstationError("failed", e.message))));
    child.on("close", (code) => finish(() => {
      if (pending) line(pending);
      if (handlerError) return reject(new WorkstationError("failed", `Handling the workstation's events failed: ${handlerError.message}`));
      let res: Response;
      try {
        res = JSON.parse(last) as Response;
      } catch {
        return reject(new WorkstationError("failed", `ws-exec exited ${code}: ${(err || last).trim().slice(0, 300)}`));
      }
      if (res.ok) resolve(res.result as T);
      else reject(new WorkstationError(res.code, res.error));
    }));
    if (keepOpen) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      input = child.stdin;
    } else child.stdin.end(`${JSON.stringify(request)}\n`);
  });
  return {
    send: (command) => void input?.write(`${JSON.stringify(command)}\n`),
    close: () => {
      input?.end();
      input = null;
    },
    done,
  };
}
