import { spawn, type ChildProcess } from "node:child_process";
import type { ExecEnv } from "./layout.ts";
import type { ExecResult } from "./protocol.ts";
import { prepareSpace } from "./space.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const running = new Set<ChildProcess>();

const exitHooks = new Set<() => void>();

/** Runs when ws-exec is stopped by a signal, after its commands are killed; returns the remover. */
export function atSignalExit(fn: () => void): () => void {
  exitHooks.add(fn);
  return () => void exitHooks.delete(fn);
}

/** When swarmd cancels (sudo relays the signal), take every command's whole process group down. */
export function killAllOnSignal(): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const child of running) killGroup(child);
      for (const fn of exitHooks) {
        try {
          fn();
        } catch {
          // Best effort: the process is going away.
        }
      }
      process.exit(143);
    });
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** A minimal, explicit environment: nothing from swarmd or sudo leaks into agent commands. */
export function childEnv(env: ExecEnv, scope: string): Record<string, string> {
  // HOME and TMPDIR belong to the scope, so runs that share a workstation user do not share them.
  const s = prepareSpace(env, scope);
  const cache = s.cache;
  return {
    HOME: s.home,
    USER: env.user,
    LOGNAME: env.user,
    SHELL: "/bin/zsh",
    PATH: `${env.layout.nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`,
    TMPDIR: `${s.tmp}/`,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    XDG_CACHE_HOME: cache,
    npm_config_cache: `${cache}/npm`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // Mirrors belong to the swarmd user; trust exactly that directory.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: `${env.layout.mirrors}/*`,
  };
}

export interface RunOptions {
  readonly cwd: string;
  /** The scope whose space (HOME, TMPDIR) the command gets. */
  readonly scope: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
}

/** Runs argv in its own process group; stdout and stderr merged, keeping the tail when large. */
export function runProcess(env: ExecEnv, argv: readonly string[], opts: RunOptions): Promise<ExecResult> {
  const started = Date.now();
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("Empty argv");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: childEnv(env, opts.scope),
      detached: true,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    running.add(child);
    const out = new Tail(MAX_OUTPUT_BYTES);
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => out.push(b));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, opts.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      running.delete(child);
      reject(error);
    });
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      resolve({ exitCode: signal ? null : code, output: out.text(), truncated: out.truncated, timedOut, durationMs: Date.now() - started });
    };
    child.on("close", settle);
    // A daemonised grandchild (setsid) can hold the pipes open forever; do not wait for it.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signal);
      }, 500).unref();
    });
  });
}

export interface StreamOptions extends RunOptions {
  /** Added to (or replacing) the minimal environment. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Written to file descriptor 3 and closed: a secret the program reads once, never in its environment or argv. */
  readonly fd3?: string;
  /** Each complete stdout line, as it arrives; return false to stop the program. */
  readonly onLine: (line: string) => boolean | void;
  /** Also pass stderr lines to onLine (stderr's tail is kept either way). */
  readonly stderrLines?: boolean;
}

export interface StreamResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** onLine asked to stop it. */
  readonly stopped: boolean;
  readonly stderr: string;
  readonly durationMs: number;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Like runProcess, for long programs that report as they go: stdout line by line, stderr's tail at the end. */
export function streamProcess(env: ExecEnv, argv: readonly string[], opts: StreamOptions): Promise<StreamResult> {
  const started = Date.now();
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("Empty argv");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...childEnv(env, opts.scope), ...opts.extraEnv },
      detached: true,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(opts.fd3 === undefined ? [] : ["pipe" as const])],
    });
    running.add(child);
    const err = new Tail(4096);
    let stopped = false;
    let timedOut = false;
    let pending = "";
    const line = (text: string) => {
      if (stopped) return;
      if (opts.onLine(text) === false) {
        stopped = true;
        killGroup(child);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        line(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      // One endless line must not grow without bound.
      if (pending.length > MAX_LINE_BYTES) {
        line(pending);
        pending = "";
      }
    });
    let errPending = "";
    child.stderr?.on("data", (b: Buffer) => {
      err.push(b);
      if (!opts.stderrLines) return;
      errPending += b.toString("utf8");
      const lines = errPending.split("\n");
      errPending = lines.pop() ?? "";
      for (const l of lines) line(l);
    });
    // A program that exits before reading its input must not crash ws-exec (EPIPE) and orphan its group.
    child.stdin?.on("error", () => undefined);
    (child.stdio[3] as NodeJS.WritableStream | null)?.on("error", () => undefined);
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    if (opts.fd3 !== undefined) (child.stdio[3] as NodeJS.WritableStream | null)?.end(opts.fd3);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, opts.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      killGroup(child);
      running.delete(child);
      reject(error);
    });
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      if (pending) line(pending);
      if (errPending && opts.stderrLines) line(errPending);
      resolve({ exitCode: signal ? null : code, timedOut, stopped, stderr: err.text(), durationMs: Date.now() - started });
    };
    child.on("close", settle);
    child.on("exit", (code, signal) => {
      // The program is gone: its process group goes too (shells, test servers it left behind).
      killGroup(child);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signal);
      }, 500).unref();
    });
  });
}

/** Keeps the last `limit` bytes of a stream. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.byteLength;
      this.truncated = true;
    }
  }

  text(): string {
    let buf = Buffer.concat(this.chunks);
    if (buf.byteLength > this.limit) {
      buf = buf.subarray(buf.byteLength - this.limit);
      this.truncated = true;
    }
    return buf.toString("utf8");
  }
}
