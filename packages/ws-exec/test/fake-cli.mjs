// A stand-in for Claude Code and Codex in tests. It speaks their event formats (as recorded from the real
// CLIs, see apps/swarmd/test/fixtures/cli) and does real work in its directory: files, git commits.
// Driven by <cliDir>/script.json (one step per run, in order); every call is logged to <cliDir>/calls.jsonl.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const [, , runtime, ...args] = process.argv;
const cliDir = dirname(process.argv[1]);
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (flag) => args.includes(flag);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

if (has("--version")) {
  console.log(runtime === "claude" ? "2.1.302 (Claude Code)" : "codex-cli 0.163.0");
  process.exit(0);
}

const codexHome = process.env.CODEX_HOME ?? "";
if (runtime === "codex" && args[0] === "login" && args[1] === "status") {
  const ok = existsSync(join(codexHome, "auth.json"));
  console.log(ok ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(ok ? 0 : 1);
}
if (runtime === "codex" && args[0] === "logout") {
  rmSync(join(codexHome, "auth.json"), { force: true });
  console.log("Successfully logged out");
  process.exit(0);
}
if (runtime === "codex" && args[0] === "login") {
  console.log("Follow these steps to sign in with ChatGPT using device code authorization:");
  console.log("\u001b[1m1. Open this link in your browser and sign in to your account\u001b[0m");
  console.log("   https://auth.openai.com/codex/device");
  console.log("2. Enter this one-time code (expires in 15 minutes)");
  console.log("   \u001b[94mFAKE-12345\u001b[0m");
  for (let i = 0; i < 400; i++) {
    if (existsSync(join(cliDir, "approve-login"))) {
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fake" } }));
      console.log("Successfully logged in");
      process.exit(0);
    }
    if (existsSync(join(cliDir, "deny-login"))) {
      console.error("Error logging in: the device code was not confirmed");
      process.exit(1);
    }
    await sleep(50);
  }
  process.exit(1);
}

// ---- a run ----------------------------------------------------------------------------------
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
let token = null;
if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR === "3") {
  const buf = Buffer.alloc(4096);
  try {
    const n = readSync(3, buf, 0, buf.length, null);
    token = buf.subarray(0, n).toString("utf8");
  } catch {
    token = null;
  }
}
const resume = runtime === "claude" ? after("--resume") : args[1] === "resume" ? args[2] : undefined;
const state = existsSync(join(cliDir, "state.json")) ? JSON.parse(readFileSync(join(cliDir, "state.json"), "utf8")) : { next: 0 };
const script = existsSync(join(cliDir, "script.json")) ? JSON.parse(readFileSync(join(cliDir, "script.json"), "utf8")) : [];
const step = script[state.next] ?? {};
writeFileSync(join(cliDir, "state.json"), JSON.stringify({ next: state.next + 1 }));
const envText = Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join("\n");
appendFileSync(join(cliDir, "calls.jsonl"), `${JSON.stringify({
  runtime, args, prompt, resume: resume ?? null, cwd: process.cwd(), codexHome: codexHome || null, path: process.env.PATH,
  tokenLength: token ? token.length : 0, tokenInEnv: Boolean(token) && envText.includes(token), home: process.env.HOME,
})}\n`);

if (resume && step.failResume) {
  console.error(`No conversation found with session ID: ${resume}`);
  process.exit(1);
}

const sh = (cmd) => {
  try {
    return execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}(exit ${e.status})`;
  }
};
const session = resume ?? randomUUID();
const report = step.report === null ? null : step.report ?? { summary: `Done: ${step.commit ?? "nothing to change"}`, tests: "node --test: 1 passed", unfinished: [] };
let probe = null;
if (step.probe) probe = sh(step.probe);
if (step.longLived) {
  // Something that would outlive the CLI if nobody killed its process group.
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  writeFileSync(join(cliDir, "sleeper.pid"), String(child.pid));
}

const actions = [];
for (const w of step.write ?? []) {
  mkdirSync(dirname(join(process.cwd(), w.path)), { recursive: true });
  writeFileSync(join(process.cwd(), w.path), w.content);
  actions.push({ kind: "edit", path: w.path });
}
if (step.commit) {
  sh(`git add -A && git commit -q -m ${JSON.stringify(step.commit)}`);
  actions.push({ kind: "shell", command: `git commit -m ${JSON.stringify(step.commit)}`, output: sh("git log -1 --oneline") });
}
for (let i = 0; i < (step.tools ?? 0); i++) actions.push({ kind: "shell", command: `echo step ${i}`, output: `step ${i}\n` });

if (runtime === "claude") {
  out({ type: "system", subtype: "init", session_id: session, model: after("--model") ?? "claude-sonnet-5-5", tools: (after("--tools") ?? "").split(","), permissionMode: after("--permission-mode"), apiKeySource: "none", cwd: process.cwd() });
  if (step.quota) out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: step.quota.five, resetsAt: Math.round(Date.now() / 1000) + 3600 }, seven_day: { utilization: step.quota.seven, resetsAt: Math.round(Date.now() / 1000) + 86400 } } }, session_id: session });
  let n = 0;
  for (const a of actions) {
    const id = `toolu_${++n}`;
    const msg = `msg_${n}`;
    if (a.kind === "edit") {
      out({ type: "assistant", message: { id: msg, role: "assistant", content: [{ type: "tool_use", id, name: "Write", input: { file_path: join(process.cwd(), a.path) } }] }, session_id: session });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `File created successfully at: ${a.path}` }] }, session_id: session });
    } else {
      out({ type: "assistant", message: { id: msg, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: a.command } }] }, session_id: session });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: a.output, is_error: false }] }, session_id: session });
    }
  }
  if (step.text) out({ type: "assistant", message: { id: "msg_text", role: "assistant", content: [{ type: "text", text: step.text }] }, session_id: session });
  if (step.sleepMs) await sleep(step.sleepMs);
  const maxTurns = Number(after("--max-turns") ?? 1000);
  const turns = actions.length + 1;
  const summary = probe !== null && report ? { ...report, summary: `${report.summary}\nprobe: ${probe}` } : report;
  if (turns > maxTurns) {
    out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: maxTurns, total_cost_usd: step.usd ?? 0.05, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }, session_id: session });
  } else {
    out({
      type: "result", subtype: step.error ? "error_during_execution" : "success", is_error: Boolean(step.error), num_turns: turns, total_cost_usd: step.usd ?? 0.05,
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
      result: step.error ?? (summary ? JSON.stringify(summary) : step.text ?? ""), ...(summary && !step.error ? { structured_output: summary } : {}), session_id: session,
    });
  }
} else {
  out({ type: "thread.started", thread_id: session });
  out({ type: "turn.started" });
  let n = 0;
  for (const a of actions) {
    const id = `item_${++n}`;
    if (a.kind === "edit") {
      out({ type: "item.started", item: { id, type: "file_change", changes: [{ path: a.path, kind: "add" }], status: "in_progress" } });
      out({ type: "item.completed", item: { id, type: "file_change", changes: [{ path: a.path, kind: "add" }], status: "completed" } });
    } else {
      out({ type: "item.started", item: { id, type: "command_execution", command: a.command, aggregated_output: "", exit_code: null, status: "in_progress" } });
      out({ type: "item.completed", item: { id, type: "command_execution", command: a.command, aggregated_output: a.output, exit_code: 0, status: "completed" } });
    }
  }
  if (step.text) out({ type: "item.completed", item: { id: `item_${++n}`, type: "agent_message", text: step.text } });
  if (step.sleepMs) await sleep(step.sleepMs);
  const summary = probe !== null && report ? { ...report, summary: `${report.summary}\nprobe: ${probe}` } : report;
  if (summary) out({ type: "item.completed", item: { id: `item_${++n}`, type: "agent_message", text: JSON.stringify(summary) } });
  if (step.error) out({ type: "turn.failed", error: { message: step.error } });
  else out({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 80, reasoning_output_tokens: 20 } });
}
process.exit(step.exitCode ?? (step.error ? 1 : 0));
