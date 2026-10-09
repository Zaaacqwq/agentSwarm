#!/usr/bin/env bun
/**
 * P4 handoff acceptance: DevB starts a two-part task, does part one, hands off with the six-section note;
 * DevA resumes the same branch on another workstation, finishes part two and opens the PR.
 *
 *   HIVE_PASSWORD=... bun evals/runner/p4-handoff.ts --url http://127.0.0.1:4319
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROLE_TEMPLATES } from "../../packages/core/src/contracts/tasks.ts";

const { values: opts } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:4318" }, model: { type: "string", default: "qwen/qwen3.8-omni-flash" } } });

let cookie = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${opts.url}/api${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : null });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface Task { id: string; number: number; status: string; assigneeAgentId: string | null; prUrl: string | null; branch: string | null; spentUsd: number }
interface TaskEvent { kind: string; actorName: string; data: Record<string, unknown> }

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 15 * 60_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await Bun.sleep(4000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

await api("POST", "/auth/login", { username: process.env.HIVE_USER ?? "admin", password: process.env.HIVE_PASSWORD });
const endpoint = (await api<{ id: string; name: string }[]>("GET", "/endpoints"))[0]!;
const workstations = await api<{ id: string; osUser: string }[]>("GET", "/workstations");
const repo = (await api<{ id: string; name: string }[]>("GET", "/repositories")).find((r) => r.name === "hive-sandbox")!;
const sfx = Date.now().toString(36).slice(-3);
const dev = async (name: string, osUser: string) => {
  const a = await api<{ id: string; name: string }>("POST", "/agents", { name, role: "Developer", instructions: ROLE_TEMPLATES.dev.instructions, endpointId: endpoint.id, modelId: opts.model, thinkingLevel: "low", grants: ROLE_TEMPLATES.dev.grants });
  await api("PUT", `/agents/${a.id}/workstation`, { workstationId: workstations.find((w) => w.osUser === osUser)!.id });
  return a;
};
const devA = await dev(`HandA${sfx}`, "ws-1");
const devB = await dev(`HandB${sfx}`, "ws-2");

const task = await api<Task>("POST", "/tasks", {
  title: `Stats helpers ${sfx}`,
  description: [
    "In hive-sandbox create src/stats.ts with two exported functions and tests in test/stats.test.ts:",
    "Part 1: mean(numbers: number[]): number (throws on an empty array).",
    "Part 2: median(numbers: number[]): number (numeric sort, mean of the two middle values for even lengths).",
    `${devB.name}: do ONLY part 1 (mean and its tests), run the tests, git_commit, then immediately call task_handoff to ${devA.name} ` +
      "with all six sections (背景, 已完成, 未完成与下一步, 分支与状态, 如何验证, 注意事项). Do not open a PR yourself.",
    `${devA.name}: when handed the task, call task_start, finish part 2, run bun test test/stats.test.ts, then git_commit, git_push and pr_create.`,
  ].join("\n"),
  acceptance: ["mean and median exported from src/stats.ts", "test/stats.test.ts covers both and passes"],
  repositoryId: repo.id,
  assigneeAgentId: devB.id,
});
console.log(`created T-${task.number}`);

const final = await until("PR from the receiving dev", async () => {
  const t = (await api<Task[]>("GET", "/tasks")).find((x) => x.id === task.id)!;
  const agents = await api<{ id: string; state: string }[]>("GET", "/agents");
  const idle = agents.filter((a) => a.id === devA.id || a.id === devB.id).every((a) => a.state === "idle");
  return t.prUrl && idle ? t : null;
});
const events = (await api<{ events: TaskEvent[] }>("GET", `/tasks/${task.id}`)).events;
const handoff = events.find((e) => e.kind === "handoff");
const prBy = events.find((e) => e.kind === "pr_opened")?.actorName;

// Verify the branch on GitHub has both functions.
const dir = mkdtempSync(join(tmpdir(), "hive-handoff-"));
const clone = Bun.spawnSync(["gh", "repo", "clone", "Zaaacqwq/hive-sandbox", "r", "--", "--quiet", "--branch", final.branch!], { cwd: dir });
const stats = clone.exitCode === 0 ? await Bun.file(join(dir, "r", "src", "stats.ts")).text().catch(() => "") : "";
const test = clone.exitCode === 0 ? Bun.spawnSync([process.execPath, "test", "test/stats.test.ts"], { cwd: join(dir, "r") }) : null;
rmSync(dir, { recursive: true, force: true });

console.log(`handoff: ${handoff ? `${handoff.data.from} → ${handoff.data.to} (${handoff.data.pushed})` : "none"}`);
console.log(`PR: ${final.prUrl} opened by ${prBy}`);
console.log(`branch ${final.branch}: mean=${/export function mean/.test(stats)} median=${/export function median/.test(stats)} tests=${test?.exitCode === 0 ? "pass" : "fail"}`);
console.log(`history: ${events.map((e) => e.kind).join(" → ")}`);
const usage = await Promise.all([devA, devB].map((a) => api<{ costUsd: number }>("GET", `/agents/${a.id}/usage`)));
console.log(`cost: $${usage.reduce((s, u) => s + u.costUsd, 0).toFixed(4)}`);
if (final.prUrl) Bun.spawnSync(["gh", "pr", "close", final.prUrl, "--delete-branch"]);
