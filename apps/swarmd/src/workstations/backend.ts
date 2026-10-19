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

/** Runs one ws-exec request as a workstation user. */
export interface WorkstationBackend {
  call<T>(osUser: string, request: Request, opts?: CallOptions): Promise<T>;
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
    return runJson<T>(["/usr/bin/sudo", "-n", this.launchPath, osUser], { PATH: "/usr/bin:/bin" }, request, opts);
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
    return runJson<T>([process.execPath, this.entry], { PATH: "/usr/bin:/bin", WS_EXEC_TEST_ENV: JSON.stringify(env) }, request, opts);
  }

  async listUsers(): Promise<string[]> {
    return [...this.envs.keys()];
  }
}

function runJson<T>(argv: string[], env: Record<string, string>, request: Request, opts: CallOptions): Promise<T> {
  const [cmd, ...args] = argv as [string, ...string[]];
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new WorkstationError("cancelled", "Cancelled"));
    const child = spawn(cmd, args, { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(JSON.stringify(request));
  });
}
