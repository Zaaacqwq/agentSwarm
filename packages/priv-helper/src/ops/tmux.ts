import { mkdirSync } from "node:fs";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { runProcess } from "../process.ts";
import { sandboxProfile } from "../sandbox.ts";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];

function tmuxBin(): string {
  const found = TMUX.find((p) => Bun.file(p).size > 0);
  if (!found) throw new OpError("failed", "tmux is not installed");
  return found;
}

function socket(env: ExecEnv): string {
  mkdirSync(`${env.root}/.tmux`, { recursive: true, mode: 0o700 });
  return `${env.root}/.tmux/default`;
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new OpError("bad_request", "Terminal names use letters, digits, - and _");
  return name;
}

async function tmux(env: ExecEnv, args: string[]) {
  return runProcess(env, [tmuxBin(), "-S", socket(env), ...args], { cwd: env.root, timeoutMs: 15_000 });
}

export async function create(env: ExecEnv, scope: string, name: string) {
  const cwd = resolveScope(env.root, scope);
  // The shell inside tmux is sandboxed exactly like ws_bash commands.
  const shell = env.sandbox
    ? `/usr/bin/sandbox-exec -p ${shellQuote(sandboxProfile(env))} /bin/zsh -l`
    : "/bin/zsh -l";
  const res = await tmux(env, ["new-session", "-d", "-s", checkName(name), "-c", cwd, "-x", "200", "-y", "50", shell]);
  if (res.exitCode !== 0) throw new OpError(res.output.includes("duplicate session") ? "conflict" : "failed", res.output.trim());
  return { name };
}

export async function send(env: ExecEnv, name: string, keys: string, enter = true) {
  const res = await tmux(env, ["send-keys", "-t", checkName(name), "-l", keys]);
  if (res.exitCode !== 0) throw new OpError("not_found", res.output.trim());
  if (enter) await tmux(env, ["send-keys", "-t", name, "Enter"]);
  return { name };
}

export async function read(env: ExecEnv, name: string, lines = 80) {
  const n = Math.min(Math.max(1, lines), 2000);
  const res = await tmux(env, ["capture-pane", "-p", "-J", "-t", checkName(name), "-S", `-${n}`]);
  if (res.exitCode !== 0) throw new OpError("not_found", res.output.trim());
  return { name, output: res.output.replace(/\n+$/, "") };
}

export async function kill(env: ExecEnv, name: string) {
  const res = await tmux(env, ["kill-session", "-t", checkName(name)]);
  if (res.exitCode !== 0) throw new OpError("not_found", res.output.trim());
  return { name };
}

export async function listSessions(env: ExecEnv) {
  const res = await tmux(env, ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{pane_current_command}"]);
  if (res.exitCode !== 0) return { sessions: [] };
  const sessions = res.output.split("\n").filter(Boolean).map((l) => {
    const [name, created, command] = l.split("\t");
    return { name: name ?? "", createdAt: Number(created ?? 0) * 1000, command: command ?? "" };
  });
  return { sessions };
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
