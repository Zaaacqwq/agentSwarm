import type { ExecEnv } from "./layout.ts";
import type { ExecResult } from "./protocol.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
}

/** Minimal, explicit environment: nothing from the caller (hived or sudo) leaks through. */
export function childEnv(env: ExecEnv): Record<string, string> {
  return {
    HOME: env.home,
    USER: env.user,
    LOGNAME: env.user,
    SHELL: "/bin/zsh",
    PATH: `${env.layout.binDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: `${env.root}/.tmp/`,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // Mirrors are owned by the hived user; trust exactly that directory (env config counts as protected).
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: `${env.layout.mirrors}/*`,
  };
}

/** Runs argv, merging stdout and stderr, keeping only the tail when output is large. */
export async function runProcess(env: ExecEnv, argv: readonly string[], opts: RunOptions): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: childEnv(env),
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
  });
  const [out, err] = await Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  const exitCode = await proc.exited;
  const combined = err.text ? (out.text ? `${out.text}\n${err.text}` : err.text) : out.text;
  const durationMs = Date.now() - started;
  return {
    exitCode: proc.signalCode ? null : exitCode,
    output: combined,
    truncated: out.truncated || err.truncated,
    timedOut: proc.signalCode === "SIGKILL" && durationMs >= opts.timeoutMs - 50,
    durationMs,
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
    while (size > MAX_OUTPUT_BYTES && chunks.length > 1) {
      size -= chunks.shift()!.byteLength;
      truncated = true;
    }
  }
  let buf = Buffer.concat(chunks);
  if (buf.byteLength > MAX_OUTPUT_BYTES) {
    buf = buf.subarray(buf.byteLength - MAX_OUTPUT_BYTES);
    truncated = true;
  }
  return { text: buf.toString("utf8"), truncated };
}
