import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { CLI_RUNTIMES, OpError, type CliRunResult, type CliRuntime, type CliStatus } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { childEnv, streamProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";
import { prepareSpace } from "../space.ts";

export const CLI_MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_PROMPT = 100_000;
const MODEL = /^[A-Za-z0-9._:/[\]-]{1,100}$/;
const SESSION = /^[A-Za-z0-9-]{8,80}$/;
/** Longest string kept in a forwarded event; tool output and file contents beyond it are cut. */
const MAX_FIELD = 8000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** What both CLIs must hand back at the end (their structured-output option). */
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "What you did, what is committed, anything the reviewer should know" },
    tests: { type: "string", description: "The tests you ran and their results" },
    unfinished: { type: "array", items: { type: "string" }, description: "What is left undone (empty if nothing)" },
  },
  required: ["summary", "tests", "unfinished"],
} as const;

/** The only tools Claude Code gets: files and the shell, no web, no sub-agents, no scheduling. */
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";
/** Codex items that count as one action against maxTurns (it has no turn limit of its own). */
const CODEX_ACTIONS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

export type Emit = (event: unknown) => void;

const claudeBin = (env: ExecEnv) => join(env.layout.cliDir, "claude", "claude");
const codexBin = (env: ExecEnv) => join(env.layout.cliDir, "codex", "bin", "codex");
/** Each workstation signs in to Codex once; only Codex runs on it may touch this directory. */
export const codexHome = (env: ExecEnv) => join(env.root, ".codex");

function codexEnv(env: ExecEnv, scope: string): Record<string, string> {
  const home = codexHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Codex looks for its bundled ripgrep on PATH.
  return { CODEX_HOME: home, PATH: `${join(env.layout.cliDir, "codex", "codex-path")}:${childEnv(env, scope).PATH}` };
}

export async function run(env: ExecEnv, r: { scope: string; runtime: CliRuntime; prompt: string; resume?: string; model?: string; maxTurns: number; timeoutMs: number; credential?: string }, emit: Emit): Promise<CliRunResult> {
  if (!CLI_RUNTIMES.includes(r.runtime)) throw new OpError("bad_request", `Unknown runtime ${String(r.runtime)}`);
  if (typeof r.prompt !== "string" || !r.prompt.trim() || r.prompt.length > MAX_PROMPT) throw new OpError("bad_request", "The prompt must be 1 to 100000 characters");
  if (r.resume !== undefined && !SESSION.test(r.resume)) throw new OpError("bad_request", "Invalid session id");
  if (r.model !== undefined && !MODEL.test(r.model)) throw new OpError("bad_request", "Invalid model id");
  if (!Number.isInteger(r.maxTurns) || r.maxTurns < 1 || r.maxTurns > 500) throw new OpError("bad_request", "maxTurns must be 1 to 500");
  if (r.runtime === "claude_code" && !r.credential) throw new OpError("bad_request", "Claude Code needs its token");
  const cwd = resolveScope(env.root, r.scope);
  if (!existsSync(cwd)) throw new OpError("not_found", `${r.scope} does not exist`);
  const timeoutMs = Math.min(Math.max(10_000, r.timeoutMs), CLI_MAX_TIMEOUT_MS);
  const space = prepareSpace(env, r.scope);
  const isCodex = r.runtime === "codex";
  if (!existsSync(isCodex ? codexBin(env) : claudeBin(env))) throw new OpError("not_found", `${r.runtime} is not installed; run scripts/setup.sh`);

  let argv: string[];
  let extraEnv: Record<string, string>;
  if (isCodex) {
    const schemaFile = join(space.tmp, "report-schema.json");
    writeFileSync(schemaFile, JSON.stringify(REPORT_SCHEMA), { mode: 0o600 });
    const flags = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--strict-config", "-c", 'web_search="disabled"', "--output-schema", schemaFile, ...(r.model ? ["-m", r.model] : [])];
    // The prompt comes on stdin ("-"): no length limit, and not visible in `ps`.
    argv = [codexBin(env), "exec", ...(r.resume ? ["resume", r.resume] : []), ...flags, "-"];
    extraEnv = codexEnv(env, r.scope);
  } else {
    argv = [
      claudeBin(env), "-p", "--output-format", "stream-json", "--verbose",
      "--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--permission-mode", "bypassPermissions",
      // No settings, hooks or MCP servers from anywhere, the repository included.
      "--setting-sources", "", "--strict-mcp-config",
      "--max-turns", String(r.maxTurns), "--json-schema", JSON.stringify(REPORT_SCHEMA),
      ...(r.model ? ["--model", r.model] : []), ...(r.resume ? ["--resume", r.resume] : []),
    ];
    // The token goes through file descriptor 3, so the shell commands Claude runs never see it in their environment.
    extraEnv = { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  }

  let actions = 0;
  let stoppedFor: CliRunResult["stoppedFor"] = null;
  const res = await streamProcess(env, sandboxed(env, argv, r.scope, isCodex ? [codexHome(env)] : []), {
    cwd, scope: r.scope, timeoutMs, stdin: r.prompt, extraEnv, ...(isCodex ? {} : { fd3: r.credential! }),
    onLine: (text) => {
      if (!text.trim()) return;
      let event: unknown;
      try {
        event = shrink(JSON.parse(text));
      } catch {
        event = { type: "agentswarm.text", text: text.slice(0, MAX_FIELD) };
      }
      emit(event);
      const e = event as { type?: string; item?: { type?: string } };
      if (isCodex && e.type === "item.completed" && CODEX_ACTIONS.has(e.item?.type ?? "") && ++actions >= r.maxTurns) {
        stoppedFor = "turns";
        return false;
      }
    },
  });
  return { exitCode: res.exitCode, timedOut: res.timedOut, stoppedFor, stderr: res.stderr, durationMs: res.durationMs };
}

/** Codex device-code sign-in: the URL and code arrive as lines while it waits for the person. */
export async function login(env: ExecEnv, emit: Emit): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const scope = "cli-login";
  const cwd = resolveScope(env.root, scope);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (!existsSync(codexBin(env))) throw new OpError("not_found", "codex is not installed; run scripts/setup.sh");
  const res = await streamProcess(env, sandboxed(env, [codexBin(env), "login", "--device-auth"], scope, [codexHome(env)]), {
    cwd, scope, timeoutMs: LOGIN_TIMEOUT_MS, extraEnv: { ...codexEnv(env, scope), NO_COLOR: "1" },
    onLine: (text) => {
      const clean = stripAnsi(text).trim();
      if (clean) emit({ type: "line", text: clean.slice(0, 500) });
    },
  });
  // Codex prints the device code on stderr in some versions; pass along what is there too.
  for (const l of stripAnsi(res.stderr).split("\n").map((s) => s.trim()).filter(Boolean)) emit({ type: "line", text: l.slice(0, 500) });
  return { exitCode: res.exitCode, timedOut: res.timedOut };
}

export async function logout(env: ExecEnv): Promise<{ signedOut: boolean }> {
  const scope = "cli-login";
  const cwd = resolveScope(env.root, scope);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (!existsSync(codexBin(env))) return { signedOut: true };
  const res = await streamProcess(env, sandboxed(env, [codexBin(env), "logout"], scope, [codexHome(env)]), {
    cwd, scope, timeoutMs: 60_000, extraEnv: codexEnv(env, scope), onLine: () => undefined,
  });
  return { signedOut: res.exitCode === 0 };
}

export async function status(env: ExecEnv): Promise<CliStatus> {
  const scope = "cli-login";
  const cwd = resolveScope(env.root, scope);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const version = async (bin: string, extra: Record<string, string> = {}): Promise<string | null> => {
    if (!existsSync(bin)) return null;
    const out = await quick(env, scope, cwd, [bin, "--version"], extra, []);
    return out.code === 0 ? (out.text.match(/\d+\.\d+\.\d+/)?.[0] ?? out.text.trim().slice(0, 40)) : null;
  };
  const claude = await version(claudeBin(env), { DISABLE_AUTOUPDATER: "1" });
  const codex = existsSync(codexBin(env)) ? await version(codexBin(env), codexEnv(env, scope)) : null;
  const signedIn = codex ? (await quick(env, scope, cwd, [codexBin(env), "login", "status"], codexEnv(env, scope), [codexHome(env)])).code === 0 : false;
  return { claude, codex, codexSignedIn: signedIn };
}

function quick(env: ExecEnv, scope: string, cwd: string, argv: string[], extra: Record<string, string>, writable: string[]): Promise<{ code: number | null; text: string }> {
  const [cmd, ...args] = sandboxed(env, argv, scope, writable) as [string, ...string[]];
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: { ...childEnv(env, scope), ...extra }, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, text: `${stdout}${stderr}` });
    });
  });
}

/** Cuts every long string in an event, keeping its shape. */
export function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…[${value.length - MAX_FIELD} characters cut]` : value;
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => shrink(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, depth + 1)]));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
