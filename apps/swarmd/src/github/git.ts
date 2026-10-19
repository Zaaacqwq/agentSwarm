import { spawn } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** git run as the swarmd user (never inside a workstation). */
export interface GitResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface GitOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** GitHub token for this one call; reaches git through GIT_ASKPASS, never argv. */
  readonly token?: string;
}

export type GitRunner = (args: readonly string[], opts?: GitOptions) => Promise<GitResult>;

/**
 * swarmd's git: no user config, no prompts, workstation inboxes trusted for fetching.
 * `askpass` is a tiny script in the data dir that echoes SWARM_GIT_TOKEN.
 */
export function createGitRunner(opts: { askpassDir: string; inboxGlob: string }): GitRunner {
  const askpass = join(opts.askpassDir, "git-askpass.sh");
  if (!existsSync(askpass)) {
    writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) echo "$SWARM_GIT_TOKEN" ;;\nesac\n', { mode: 0o700 });
  }
  chmodSync(askpass, 0o700);
  return (args, o = {}) => new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: opts.inboxGlob,
    };
    if (o.token) Object.assign(env, { GIT_ASKPASS: askpass, SWARM_GIT_TOKEN: o.token });
    const child = spawn("/usr/bin/git", ["-c", "credential.helper=", ...args], { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 300_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

export async function gitOk(git: GitRunner, args: readonly string[], opts?: GitOptions): Promise<string> {
  const res = await git(args, opts);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.err || res.out).trim().slice(-500)}`);
  return res.out;
}
