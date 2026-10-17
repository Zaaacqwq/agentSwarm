import { spawn, type ChildProcess } from "node:child_process";
import type { ExecEnv } from "./layout.ts";
import type { ExecResult } from "./protocol.ts";
import { prepareSpace } from "./space.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const running = new Set<ChildProcess>();

/** When swarmd cancels (sudo relays the signal), take every command's whole process group down. */
export function killAllOnSignal(): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const child of running) killGroup(child);
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
