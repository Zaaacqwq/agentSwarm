// R1 acceptance against a running swarmd: set up (first run only), then one agent fixes one bug.
//   node scripts/acceptance-r1.ts [--url http://127.0.0.1:4318] [--module median]
// Secrets are read from files and never printed: ~/.config/agentswarm/{admin-password,github-token},
// and the OpenRouter key from ~/.pi/agent/auth.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:4318" },
  module: { type: "string", default: "median" },
  model: { type: "string", default: "qwen/qwen3.8-omni-flash" },
  repo: { type: "string", default: "Zaaacqwq/agentswarm-playground" },
} });
const cfg = join(homedir(), ".config/agentswarm");
let cookie = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${o.url}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const passwordFile = join(cfg, "admin-password");
if ((await api<{ required: boolean }>("GET", "/setup")).required) {
  const password = randomBytes(18).toString("base64url");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600, flag: "wx" });
  await api("POST", "/setup", { username: "admin", password });
  console.log(`first-run setup done; the admin password is in ${passwordFile}`);
} else {
  await api("POST", "/auth/login", { username: "admin", password: readFileSync(passwordFile, "utf8").trim() });
}

if (!(await api("GET", "/github")).configured) await api("PUT", "/github", { token: readFileSync(join(cfg, "github-token"), "utf8").trim() });
const gh = await api("GET", "/github");
console.log(`github: ${gh.login} ${gh.error ?? "ok"}`);

let project = (await api<any[]>("GET", "/projects")).find((p) => p.githubRepo.toLowerCase() === o.repo.toLowerCase());
project ??= await api("POST", "/projects", { githubRepo: o.repo });
console.log(`project: ${project.githubRepo} default=${project.defaultBranch} protected=${Boolean(project.protectedAt)}`);

let endpoint = (await api<any[]>("GET", "/endpoints")).find((e) => e.kind === "openrouter");
if (!endpoint) {
  const key = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")).openrouter.key as string;
  endpoint = await api("POST", "/endpoints", { name: "OpenRouter", kind: "openrouter", apiKey: key });
}
let agent = (await api<any[]>("GET", "/agents")).find((a) => a.name === "Dev" && a.projectId === project.id);
agent ??= await api("POST", "/agents", { name: "Dev", projectId: project.id, role: "developer", endpointId: endpoint.id, modelId: o.model });

const brief = [
  `The test test/${o.module}.test.js fails. Find the bug in src/${o.module}.js and fix the code, not the test.`,
  "Run `npm test` (or node --test) to confirm, commit with a clear message, push, and report what you changed and the test output.",
].join(" ");
const started = Date.now();
const run = await api("POST", `/agents/${agent.id}/runs`, { title: `Fix ${o.module}`, brief });
console.log(`run ${run.id} on branch ${run.branch}`);
let view = run;
while (view.status === "queued" || view.status === "running") {
  await new Promise((r) => setTimeout(r, 3000));
  view = await api("GET", `/runs/${run.id}`);
}
const events = await api<any[]>("GET", `/runs/${run.id}/events`);
for (const e of events) {
  if (e.type === "tool_start") console.log(`  → ${e.data.name} ${JSON.stringify(e.data.args).slice(0, 140)}`);
  if (e.type === "tool_end" && e.data.isError) console.log(`    ✕ ${String(e.data.output).slice(0, 200)}`);
  if (e.type === "push") console.log(`  relay: ${e.data.status} ${e.data.reason ?? ""}`);
  if (e.type === "error") console.log(`  problem: ${e.data.message}`);
}
console.log(`\nstatus: ${view.status}${view.error ? ` (${view.error})` : ""}`);
console.log(`turns ${view.turns} · tokens ${view.tokensIn}/${view.tokensOut} · $${view.costUsd.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)} s`);
if (view.report) console.log(`report: ${view.report.summary}\ntests: ${view.report.tests}`);
console.log(`branch: ${view.branch}`);
process.exit(view.status === "succeeded" ? 0 : 1);
