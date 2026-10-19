import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { CLI_RUNTIMES, OpError, type CliRunResult, type CliRuntime, type CliStatus } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { atSignalExit, childEnv, streamProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";
import { prepareSpace } from "../space.ts";

export const CLI_MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_PROMPT = 100_000;
// Both start with a letter or digit, so neither can be read as an option.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
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

/** What a CLI reviewer hands back instead (R5). */
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    approved: { type: "boolean", description: "true only if the branch can be merged as it is" },
    comments: { type: "string", description: "Specific, actionable comments; what you checked and what you found" },
  },
  required: ["approved", "comments"],
} as const;

/** The only tools Claude Code gets: files and the shell, no web, no sub-agents, no scheduling. */
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";
/** Codex items that count as one action (it has no turn limit of its own). */
const CODEX_ACTIONS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
/** A model turn often runs several commands; Codex gets this many actions per allowed turn. */
export const CODEX_ACTIONS_PER_TURN = 3;

export type Emit = (event: unknown) => void;

const claudeBin = (env: ExecEnv) => join(env.layout.cliDir, "claude", "claude");
const codexBin = (env: ExecEnv) => join(env.layout.cliDir, "codex", "bin", "codex");
/**
 * Each workstation signs in to Codex once, here. Runs never see this directory: each gets its own
 * Codex home in its scope with a copy of the sign-in (see run), so one run cannot plant config or read
 * another run's transcripts.
 */
export const codexHome = (env: ExecEnv) => join(env.root, ".codex");

function codexEnv(env: ExecEnv, scope: string, home: string): Record<string, string> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Codex looks for its bundled ripgrep on PATH.
  return { CODEX_HOME: home, PATH: `${join(env.layout.cliDir, "codex", "codex-path")}:${childEnv(env, scope).PATH}` };
}

/** The ChatGPT account a Codex auth.json signs in as, or null if it is not a sign-in. */
function codexAccount(text: string | null): string | null {
  if (!text) return null;
  try {
    const auth = JSON.parse(text) as { tokens?: { account_id?: unknown; refresh_token?: unknown } };
    return typeof auth.tokens?.account_id === "string" && typeof auth.tokens.refresh_token === "string" ? auth.tokens.account_id : null;
  } catch {
    return null;
  }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** Gives a run its own copy of the workstation's sign-in. */
function lendCodexAuth(env: ExecEnv, runHome: string): string {
  const original = readText(join(codexHome(env), "auth.json"));
  if (!codexAccount(original)) throw new OpError("conflict", "Codex is not signed in on this workstation");
  mkdirSync(runHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(runHome, "auth.json"), original!, { mode: 0o600 });
  return original!;
}

/**
 * Codex rotates its refresh token, so the run's copy is the current one afterwards. It goes back only
 * if it still signs in to the same account: a run must not swap in a sign-in of its choosing.
 */
function returnCodexAuth(env: ExecEnv, runHome: string, original: string): void {
  const now = readText(join(runHome, "auth.json"));
  if (!now || now === original || codexAccount(now) !== codexAccount(original)) return;
  const target = join(codexHome(env), "auth.json");
  writeFileSync(`${target}.tmp`, now, { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

export async function run(env: ExecEnv, r: { scope: string; runtime: CliRuntime; prompt: string; resume?: string; model?: string; maxTurns: number; timeoutMs: number; credential?: string; output?: "report" | "review" }, emit: Emit): Promise<CliRunResult> {
  const schema = r.output === "review" ? REVIEW_SCHEMA : REPORT_SCHEMA;
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
  const runCodexHome = join(space.home, ".codex");
  let lent: string | null = null;
  if (isCodex) {
    lent = lendCodexAuth(env, runCodexHome);
    const schemaFile = join(space.tmp, "report-schema.json");
    writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    const flags = [
      "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--strict-config",
      // Nothing from config files or exec-policy rules, wherever they came from.
      "--ignore-user-config", "--ignore-rules", "-c", 'web_search="disabled"',
      "--output-schema", schemaFile, ...(r.model ? ["-m", r.model] : []),
    ];
    // The prompt comes on stdin ("-"): no length limit, and not visible in `ps`.
    argv = [codexBin(env), "exec", ...(r.resume ? ["resume", r.resume] : []), ...flags, "-"];
    extraEnv = codexEnv(env, r.scope, runCodexHome);
  } else {
    argv = [
      claudeBin(env), "-p", "--output-format", "stream-json", "--verbose",
      "--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--permission-mode", "bypassPermissions",
      // No settings, hooks or MCP servers from anywhere, the repository included.
      "--setting-sources", "", "--strict-mcp-config",
      "--max-turns", String(r.maxTurns), "--json-schema", JSON.stringify(schema),
      ...(r.model ? ["--model", r.model] : []), ...(r.resume ? ["--resume", r.resume] : []),
    ];
    // The token goes through file descriptor 3, so the shell commands Claude runs never see it in their environment.
    extraEnv = { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  }

  let actions = 0;
  let stoppedFor: CliRunResult["stoppedFor"] = null;
  const maxActions = r.maxTurns * CODEX_ACTIONS_PER_TURN;
  // A cancelled run still hands back a rotated sign-in.
  const giveBack = () => {
    if (lent !== null) returnCodexAuth(env, runCodexHome, lent);
  };
  const removeHook = atSignalExit(giveBack);
  const res = await streamProcess(env, sandboxed(env, argv, r.scope), {
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
      if (isCodex && e.type === "item.completed" && CODEX_ACTIONS.has(e.item?.type ?? "") && ++actions >= maxActions) {
        stoppedFor = "turns";
        return false;
      }
    },
  }).finally(() => {
    removeHook();
    giveBack();
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
    cwd, scope, timeoutMs: LOGIN_TIMEOUT_MS, extraEnv: { ...codexEnv(env, scope, codexHome(env)), NO_COLOR: "1" },
    // Some versions print the device code on stderr: both streams, as they come.
    stderrLines: true,
    onLine: (text) => {
      const clean = stripAnsi(text).trim();
      if (clean) emit({ type: "line", text: clean.slice(0, 500) });
    },
  });
  return { exitCode: res.exitCode, timedOut: res.timedOut };
}

export async function logout(env: ExecEnv): Promise<{ signedOut: boolean }> {
  const scope = "cli-login";
  const cwd = resolveScope(env.root, scope);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (!existsSync(codexBin(env))) return { signedOut: true };
  const res = await streamProcess(env, sandboxed(env, [codexBin(env), "logout"], scope, [codexHome(env)]), {
    cwd, scope, timeoutMs: 60_000, extraEnv: codexEnv(env, scope, codexHome(env)), onLine: () => undefined,
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
  const home = codexHome(env);
  const codex = existsSync(codexBin(env)) ? await version(codexBin(env), codexEnv(env, scope, home)) : null;
  let signedIn: boolean | null = false;
  if (codex) {
    const st = await quick(env, scope, cwd, [codexBin(env), "login", "status"], codexEnv(env, scope, home), [home]);
    // Only a clear answer counts; a timeout or a crash says nothing about the sign-in.
    signedIn = st.code === 0 ? true : /not logged in/i.test(st.text) ? false : null;
  }
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
