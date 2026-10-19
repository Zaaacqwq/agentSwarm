// R2 acceptance against a running swarmd: a lead splits three features across sub-agents (one of
// which spawns its own), reviews and merges them, and opens one pull request.
//   node scripts/acceptance-r2.ts [--url http://127.0.0.1:4318] [--budget 2]
// Needs the setup done by scripts/acceptance-r1.ts (admin, GitHub token, project, OpenRouter endpoint).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:4318" },
  model: { type: "string", default: "qwen/qwen3.8-omni-flash" },
  repo: { type: "string", default: "Zaaacqwq/agentswarm-playground" },
  budget: { type: "string", default: "2" },
  minutes: { type: "string", default: "45" },
} });
let cookie = "";
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${o.url}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

await api("POST", "/auth/login", { username: "admin", password: readFileSync(join(homedir(), ".config/agentswarm/admin-password"), "utf8").trim() });
const project = (await api<any[]>("GET", "/projects")).find((p) => p.githubRepo.toLowerCase() === o.repo.toLowerCase());
if (!project) throw new Error(`Run scripts/acceptance-r1.ts first: no project ${o.repo}`);
const endpoint = (await api<any[]>("GET", "/endpoints")).find((e) => e.kind === "openrouter");
let lead = (await api<any[]>("GET", "/agents")).find((a) => a.name === "Lead" && a.projectId === project.id);
lead ??= await api("POST", "/agents", {
  name: "Lead", projectId: project.id, role: "tech lead", endpointId: endpoint.id, modelId: o.model,
  instructions: "You coordinate. Prefer giving separate parts to sub-agents over writing everything yourself; keep each brief complete and self-contained.",
});

const brief = `Add three small, independent helpers to this repository. Each goes in its own file under src/ with a node:test test under test/ (run with node --test):

1. src/sum.js exporting sum(numbers): the sum of an array of numbers; 0 for an empty array.
2. src/range.js exporting range(start, end, step = 1): numbers from start (inclusive) to end (exclusive); throw a RangeError if step is 0.
3. String helpers: src/capitalize.js exporting capitalize(word) (first letter upper case, rest unchanged) and src/title-case.js exporting titleCase(sentence) (capitalize every word, using capitalize.js).

How to work: spawn one developer sub-agent per helper (three in total). Tell the string-helpers developer to write capitalize itself, push it, and delegate titleCase to its own sub-agent. Review every sub-agent's work, merge what is approved, run the new tests, push, open one pull request, and report.

Other modules in this repository (clamp, slugify, word-count, median) have known failing tests. Leave them alone; only make sure the new tests pass.`;

const started = Date.now();
const root = await api("POST", `/agents/${lead.id}/runs`, { title: "Three helpers", brief, budgetUsd: Number(o.budget) });
console.log(`root ${root.id} on ${root.branch}`);
const deadline = started + Number(o.minutes) * 60_000;
let view = root;
let lastLine = "";
while (!["succeeded", "failed", "cancelled"].includes(view.status)) {
  if (Date.now() > deadline) {
    console.log("timed out; cancelling the tree");
    await api("POST", `/runs/${root.id}/cancel`, {});
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
  view = await api("GET", `/runs/${root.id}`);
  const tree = await api("GET", `/trees/${root.treeId}`);
  const line = tree.nodes.map((n: any) => `${n.agentName}:${n.status}`).join(" ");
  if (line !== lastLine) console.log(`${Math.round((Date.now() - started) / 1000)}s  ${line}`);
  lastLine = line;
}

const tree = await api("GET", `/trees/${root.treeId}`);
console.log("\nTree:");
for (const n of tree.nodes) {
  const indent = "  ".repeat(n.depth);
  const extra = [n.review ? (n.review.approved ? "approved" : "changes requested") : "", n.mergedAt ? "merged" : "", n.prUrl ?? ""].filter(Boolean).join(", ");
  console.log(`${indent}- ${n.agentName} (${n.kind === "review" ? "reviewer" : n.agentRole}) ${n.status} · ${n.turns} turns · $${n.costUsd.toFixed(4)} · budget $${(n.budgetUsd ?? 0).toFixed(2)} · ${n.branch.split("/").pop()}${extra ? ` · ${extra}` : ""}${n.error ? ` · ${n.error}` : ""}`);
}
console.log(`\nroot: ${view.status}${view.error ? ` (${view.error})` : ""}`);
console.log(`total: ${tree.nodes.length} runs · $${tree.totalCostUsd.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)} s`);
if (view.report) console.log(`report: ${view.report.summary}\ntests: ${view.report.tests}`);
if (view.prUrl) console.log(`pull request: ${view.prUrl}`);
process.exit(view.status === "succeeded" && view.prUrl ? 0 : 1);
