#!/usr/bin/env bun
/**
 * P4 acceptance (HIVE_PLAN.md §12): a lead splits a three-feature request into tasks, a person approves,
 * two devs build in parallel and open PRs, a reviewer reviews, and one task is handed off mid-way.
 *
 *   HIVE_PASSWORD=... bun evals/runner/p4-acceptance.ts --url http://127.0.0.1:4319
 */
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:4318" },
    endpoint: { type: "string", default: "OpenRouter" },
    model: { type: "string", default: "qwen/qwen3.8-omni-flash" },
    keep: { type: "boolean", default: false },
  },
});

let cookie = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${opts.url}/api${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : null });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface Agent { id: string; name: string; state: string }
interface Task { id: string; number: number; title: string; status: string; assigneeAgentId: string | null; reviewerAgentId: string | null; prUrl: string | null; approved: boolean; channelId: string; spentUsd: number }
interface TaskEvent { kind: string; actorName: string; data: Record<string, unknown> }

const log = (s: string) => process.stdout.write(`${s}\n`);
const tasksNow = () => api<Task[]>("GET", "/tasks");

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 20 * 60_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await Bun.sleep(4000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function idle(ids: string[]): Promise<boolean> {
  return (await api<Agent[]>("GET", "/agents")).filter((a) => ids.includes(a.id)).every((a) => a.state === "idle");
}

async function main(): Promise<void> {
  await api("POST", "/auth/login", { username: process.env.HIVE_USER ?? "admin", password: process.env.HIVE_PASSWORD });
  const { ROLE_TEMPLATES } = await import("../../packages/core/src/contracts/tasks.ts");
  const endpoint = (await api<{ id: string; name: string }[]>("GET", "/endpoints")).find((e) => e.name === opts.endpoint)!;
  const workstations = await api<{ id: string; osUser: string }[]>("GET", "/workstations");
  const ws = (u: string) => workstations.find((w) => w.osUser === u)!.id;
  const sfx = Date.now().toString(36).slice(-3);
  const make = async (name: string, role: keyof typeof ROLE_TEMPLATES, workstation?: string): Promise<Agent> => {
    const t = ROLE_TEMPLATES[role];
    const a = await api<Agent>("POST", "/agents", { name, role: t.role, instructions: t.instructions, endpointId: endpoint.id, modelId: opts.model, thinkingLevel: "low", grants: t.grants });
    if (workstation) await api("PUT", `/agents/${a.id}/workstation`, { workstationId: ws(workstation) });
    return a;
  };
  const lead = await make(`Lead${sfx}`, "lead");
  const dev1 = await make(`DevA${sfx}`, "dev", "ws-1");
  const dev2 = await make(`DevB${sfx}`, "dev", "ws-2");
  const rev = await make(`Rev${sfx}`, "reviewer");
  const team = [lead, dev1, dev2, rev];
  const results: Record<string, string> = {};
  const before = new Set((await tasksNow()).map((t) => t.id));

  // 1. Request -> the lead proposes three tasks.
  const leadDm = await api<{ id: string }>("POST", "/channels/dm", { agentId: lead.id });
  await api("POST", `/channels/${leadDm.id}/messages`, {
    body: [
      "We need three small features in the repository hive-sandbox (TypeScript, tests with bun test):",
      "1. src/clamp.ts exporting clamp(value, min, max), with tests in test/clamp.test.ts.",
      "2. src/capitalize.ts exporting capitalize(word) that uppercases the first letter, with tests in test/capitalize.test.ts.",
      "3. src/sum.ts exporting sum(numbers: number[]) returning the total, with tests in test/sum.test.ts.",
      "Create one task per feature with repo hive-sandbox and clear acceptance criteria, then summarise the plan here and wait for my approval.",
    ].join("\n"),
  });
  const proposed = await until("three proposed tasks", async () => {
    const mine = (await tasksNow()).filter((t) => !before.has(t.id));
    return mine.length >= 3 && (await idle([lead.id])) ? mine : null;
  });
  results.proposed = proposed.map((t) => `T-${t.number} ${t.title} [${t.status}]`).join("; ");

  // 2. A person approves; the lead assigns.
  for (const t of proposed) if (!t.approved) await api("POST", `/tasks/${t.id}/approve`);
  const [a, b, c] = proposed;
  await api("POST", `/channels/${leadDm.id}/messages`, {
    body: `Approved. Assign T-${a!.number} to ${dev1.name}, T-${b!.number} to ${dev2.name} and T-${c!.number} to ${dev1.name}, each with reviewer ${rev.name}.`,
  });

  // 3. Mid-way handoff: once DevB has started its task, ask it to hand off to DevA.
  const handed = await until("DevB to start its task", async () => (await tasksNow()).find((t) => t.id === b!.id && t.status === "in_progress" && t.assigneeAgentId === dev2.id), 10 * 60_000);
  await api("POST", `/channels/${handed.channelId}/messages`, {
    body: `@${dev2.name} stop here and hand this task to ${dev1.name} now with task_handoff, writing all six sections (背景, 已完成, 未完成与下一步, 分支与状态, 如何验证, 注意事项).`,
  });

  // 4. Wait until every task has a PR approved by the reviewer, or a long timeout.
  const done = await until("all three tasks reviewed", async () => {
    const all = (await tasksNow()).filter((t) => proposed.some((p) => p.id === t.id));
    const details = await Promise.all(all.map((t) => api<{ events: TaskEvent[] }>("GET", `/tasks/${t.id}`)));
    const approved = details.filter((d) => d.events.some((e) => e.kind === "review:approve")).length;
    return approved === 3 && (await idle(team.map((x) => x.id))) ? all : null;
  }, 30 * 60_000).catch(async (error) => {
    results.timeout = String(error);
    return (await tasksNow()).filter((t) => proposed.some((p) => p.id === t.id));
  });

  for (const t of done) {
    const d = await api<{ events: TaskEvent[] }>("GET", `/tasks/${t.id}`);
    const kinds = d.events.map((e) => (e.kind === "handoff" ? `handoff(${e.data.from}→${e.data.to}, ${e.data.pushed})` : e.kind));
    const prBy = d.events.find((e) => e.kind === "pr_opened")?.actorName ?? "-";
    results[`T-${t.number}`] = `${t.status} · PR ${t.prUrl ?? "none"} (by ${prBy}) · $${t.spentUsd.toFixed(4)} · ${kinds.join(" → ")}`;
  }
  const usage = await Promise.all(team.map((x) => api<{ costUsd: number; inputTokens: number; outputTokens: number }>("GET", `/agents/${x.id}/usage`)));
  results.cost = `$${usage.reduce((s, u) => s + u.costUsd, 0).toFixed(4)} (${usage.reduce((s, u) => s + u.inputTokens, 0)} in / ${usage.reduce((s, u) => s + u.outputTokens, 0)} out)`;
  for (const [k, v] of Object.entries(results)) log(`${k}: ${v}`);

  for (const t of done) if (t.prUrl) Bun.spawnSync(["gh", "pr", "close", t.prUrl, "--delete-branch"]);
  if (!opts.keep) for (const x of team) await api("DELETE", `/agents/${x.id}`);
}

await main();
