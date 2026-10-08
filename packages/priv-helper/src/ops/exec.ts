import { mkdirSync } from "node:fs";
import type { ExecEnv } from "../layout.ts";
import { OpError, type ExecResult } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

export async function exec(env: ExecEnv, scope: string, command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
  if (!command.trim()) throw new OpError("bad_request", "Empty command");
  if (command.length > 20_000) throw new OpError("bad_request", "Command too long");
  const cwd = resolveScope(env.root, scope);
  mkdirSync(`${env.root}/.tmp`, { recursive: true, mode: 0o700 });
  const timeout = Math.min(Math.max(1000, timeoutMs), MAX_TIMEOUT_MS);
  return runProcess(env, sandboxed(env, ["/bin/zsh", "-c", command]), { cwd, timeoutMs: timeout });
}
