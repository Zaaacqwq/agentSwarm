#!/usr/bin/env bun
/**
 * Hive coding eval: for each seeded problem in hive-sandbox, a fresh dev agent is asked to fix
 * the failing test, push a branch and open a PR. We then check the pushed branch ourselves.
 *
 *   HIVE_USER=admin HIVE_PASSWORD=... bun evals/runner/run.ts --endpoint OpenRouter \
 *     --model qwen/qwen3.8-omni-flash --workstation ws-1 --runs 3 --budget 5 [--problems median,chunk] [--cleanup]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROBLEMS = ["range-sum", "slugify", "duration", "median", "chunk", "title-case", "backoff", "word-count"] as const;
const REPO = "Zaaacqwq/hive-sandbox";
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:4318" },
    endpoint: { type: "string" },
    model: { type: "string" },
    workstation: { type: "string", default: "ws-1" },
    runs: { type: "string", default: "3" },
    budget: { type: "string", default: "5" },
    problems: { type: "string" },
    thinking: { type: "string", default: "low" },
    cleanup: { type: "boolean", default: false },
  },
});

interface Attempt {
  problem: string;
  attempt: number;
  agent: string;
  success: boolean;
  reason: string;
  prUrl: string | null;
  durationS: number;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

let cookie = "";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${opts.url}/api${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function sh(cwd: string, ...cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

/** Independently verifies the pushed branch: target test passes and tests were not edited. */
async function verify(problem: string, branch: string): Promise<{ ok: boolean; reason: string }> {
  const dir = mkdtempSync(join(tmpdir(), "hive-eval-"));
  try {
    const clone = await sh(dir, "gh", "repo", "clone", REPO, "repo", "--", "--quiet", "--branch", branch);
    if (clone.code !== 0) return { ok: false, reason: "branch not found on GitHub" };
    const repo = join(dir, "repo");
    await sh(repo, "git", "fetch", "--quiet", "origin", "main");
    const testsTouched = await sh(repo, "git", "diff", "--quiet", "origin/main", "HEAD", "--", "test/");
    if (testsTouched.code !== 0) return { ok: false, reason: "edited files under test/" };
    const run = await sh(repo, process.execPath, "test", `test/${problem}.test.ts`);
    return run.code === 0 ? { ok: true, reason: "target test passes" } : { ok: false, reason: "target test still fails" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prompt(problem: string): string {
  return [
    `In the repository hive-sandbox, \`bun test test/${problem}.test.ts\` fails.`,
    `Open a worktree with ws_checkout using slug "fix-${problem}", find the bug in src/ and fix it. Do not modify anything under test/.`,
    `Run the test to confirm it passes, then git_commit, git_push and pr_create.`,
    `Reply with send_message containing the pull request URL.`,
  ].join("\n");
}

async function runOne(problem: string, attempt: number, endpointId: string, workstationId: string): Promise<Attempt> {
  const name = `eval-${problem}-r${attempt}`.slice(0, 40);
  const agent = await api<{ id: string }>("POST", "/agents", {
    name, role: "dev", endpointId, modelId: opts.model, thinkingLevel: opts.thinking,
    instructions: "You are a careful software engineer. Work in small verified steps. Keep messages short.",
    grants: [{ toolpackId: "core.communication", toolName: "*" }, { toolpackId: "core.workstation", toolName: "*" }],
  });
  await api("PUT", `/agents/${agent.id}/workstation`, { workstationId });
  const dm = await api<{ id: string }>("POST", "/channels/dm", { agentId: agent.id });
  const started = Date.now();
  await api("POST", `/channels/${dm.id}/messages`, { body: prompt(problem) });

  let state = "queued";
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    await Bun.sleep(3000);
    state = (await api<{ state: string }>("GET", `/agents/${agent.id}`)).state;
    if (state === "idle") break;
  }
  if (state !== "idle") await api("POST", `/agents/${agent.id}/stop`);

  const { runs, activity } = await api<{ runs: { inputTokens: number; outputTokens: number; costUsd: number; status: string }[]; activity: { kind: string }[] }>("GET", `/agents/${agent.id}/runs?limit=50`);
  const pushes = await api<{ status: string; prUrl: string | null; branch: string }[]>("GET", `/agents/${agent.id}/pushes`);
  const pushed = pushes.find((p) => p.status === "pushed");
  const pr = pushes.find((p) => p.prUrl)?.prUrl ?? null;
  const check = pushed ? await verify(problem, pushed.branch) : { ok: false, reason: state === "idle" ? "never pushed" : "timed out" };
  const result: Attempt = {
    problem, attempt, agent: name,
    success: check.ok && !!pr,
    reason: check.ok && !pr ? "fixed but no PR" : check.reason,
    prUrl: pr,
    durationS: Math.round((Date.now() - started) / 1000),
    toolCalls: activity.filter((a) => a.kind === "tool_call").length,
    turns: runs.length,
    inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
    costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
  };
  await api("DELETE", `/agents/${agent.id}`);
  return result;
}

function report(results: Attempt[], meta: Record<string, string>): string {
  const ok = results.filter((r) => r.success).length;
  const sum = (k: keyof Attempt) => results.reduce((s, r) => s + Number(r[k]), 0);
  const lines = [
    `# Hive coding eval — ${new Date().toISOString()}`,
    "",
    Object.entries(meta).map(([k, v]) => `- ${k}: \`${v}\``).join("\n"),
    "",
    `**Success: ${ok}/${results.length} (${results.length ? Math.round((ok / results.length) * 100) : 0}%)** · cost $${sum("costUsd").toFixed(4)} · tokens ${sum("inputTokens")} in / ${sum("outputTokens")} out · avg ${results.length ? Math.round(sum("durationS") / results.length) : 0}s`,
    "",
    "| problem | try | result | reason | time | tool calls | tokens in/out | cost | PR |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.problem} | ${r.attempt} | ${r.success ? "pass" : "FAIL"} | ${r.reason} | ${r.durationS}s | ${r.toolCalls} | ${r.inputTokens}/${r.outputTokens} | $${r.costUsd.toFixed(4)} | ${r.prUrl ?? "—"} |`),
  ];
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  if (!opts.endpoint || !opts.model) throw new Error("--endpoint and --model are required");
  const username = process.env.HIVE_USER ?? "admin";
  const password = process.env.HIVE_PASSWORD;
  if (!password) throw new Error("Set HIVE_PASSWORD");
  await api("POST", "/auth/login", { username, password });

  const endpoint = (await api<{ id: string; name: string }[]>("GET", "/endpoints")).find((e) => e.name === opts.endpoint);
  if (!endpoint) throw new Error(`No endpoint named ${opts.endpoint}`);
  const workstation = (await api<{ id: string; osUser: string }[]>("GET", "/workstations")).find((w) => w.osUser === opts.workstation);
  if (!workstation) throw new Error(`No workstation for ${opts.workstation}`);
  const repos = await api<{ name: string }[]>("GET", "/repositories");
  if (!repos.some((r) => r.name === "hive-sandbox")) await api("POST", "/repositories", { githubFullName: REPO });

  const problems = opts.problems ? opts.problems.split(",") : [...PROBLEMS];
  const runsPer = Number(opts.runs);
  const budget = Number(opts.budget);
  const results: Attempt[] = [];
  let spent = 0;
  outer: for (let attempt = 1; attempt <= runsPer; attempt++) {
    for (const problem of problems) {
      if (spent >= budget) {
        process.stderr.write(`Budget $${budget} reached; stopping.\n`);
        break outer;
      }
      const r = await runOne(problem, attempt, endpoint.id, workstation.id);
      spent += r.costUsd;
      results.push(r);
      process.stderr.write(`${r.success ? "pass" : "FAIL"} ${problem} #${attempt} ${r.durationS}s $${r.costUsd.toFixed(4)} (${r.reason})\n`);
      if (opts.cleanup && r.prUrl) await sh(".", "gh", "pr", "close", r.prUrl, "--delete-branch");
    }
  }

  const outDir = join(import.meta.dir, "..", "reports");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const meta = { model: opts.model!, thinking: opts.thinking!, workstation: opts.workstation!, runs: String(runsPer), budget: `$${budget}` };
  writeFileSync(join(outDir, `${stamp}.md`), report(results, meta));
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ meta, results }, null, 2));
  process.stdout.write(report(results, meta));
}

await main();
