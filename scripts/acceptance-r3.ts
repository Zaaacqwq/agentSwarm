// R3 acceptance against a running swarmd: connects the Discord bot, then follows the mission you start
// with /idea in Discord through every stage until it is done (or cancelled) and cleaned up.
//   node scripts/acceptance-r3.ts --channel <channel id> [--owner <your user id>] [--url http://127.0.0.1:4318] [--hours 3]
// The bot token is read from ~/.config/agentswarm/discord-token (never printed). Needs the setup done
// by scripts/acceptance-r1.ts (admin, GitHub token, project, OpenRouter endpoint, an agent).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:4318" },
  channel: { type: "string" },
  owner: { type: "string", default: "769549199007416320" },
  hours: { type: "string", default: "3" },
} });
if (!o.channel) throw new Error("Pass --channel <the Discord channel id for missions>");

let cookie = "";
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${o.url}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}
const stamp = () => new Date().toTimeString().slice(0, 8);

await api("POST", "/auth/login", { username: "admin", password: readFileSync(join(homedir(), ".config/agentswarm/admin-password"), "utf8").trim() });
const tokenFile = join(homedir(), ".config/agentswarm/discord-token");
if ((statSync(tokenFile).mode & 0o077) !== 0) throw new Error(`${tokenFile} must be readable only by you (chmod 600)`);
const status = await api("PUT", "/discord", { token: readFileSync(tokenFile, "utf8").trim(), channelId: o.channel, ownerId: o.owner });
if (!status.connected) throw new Error(`Discord did not connect: ${status.error}`);
console.log(`${stamp()} Discord: ${status.botTag} in #${status.channelName}. Start the mission with /idea in that channel.`);

const known = new Set<string>((await api<any[]>("GET", "/missions")).map((m) => m.id));
let mission: any = null;
const deadline = Date.now() + Number(o.hours) * 3_600_000;
while (!mission) {
  if (Date.now() > deadline) throw new Error("No mission started");
  await new Promise((r) => setTimeout(r, 3000));
  mission = (await api<any[]>("GET", "/missions")).find((m) => !known.has(m.id)) ?? null;
}
console.log(`${stamp()} Mission ${mission.id}: ${mission.title} (${mission.githubRepo}, budget $${mission.budgetUsd})`);

const started = Date.now();
let lastLine = "";
let after = 0;
for (;;) {
  const m = await api("GET", `/missions/${mission.id}`);
  for (const msg of await api<any[]>("GET", `/missions/${mission.id}/messages?after=${after}`)) {
    after = msg.id;
    console.log(`${stamp()}   [${msg.author}${msg.kind === "text" ? "" : `/${msg.kind}`}] ${msg.text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const line = `${m.stage}${m.waitingForYou ? " (waiting for you)" : ""} · lead ${m.leadStatus} · $${m.costUsd.toFixed(4)}`;
  if (line !== lastLine) console.log(`${stamp()} ${line}`);
  lastLine = line;
  const root = await api("GET", `/runs/${m.rootRunId}`);
  if ((m.stage === "done" || m.stage === "cancelled") && (root.cleanedAt || (m.stage === "cancelled" && root.prState === "open"))) break;
  if (Date.now() > deadline) {
    console.log("Out of time; the mission keeps going in swarmd.");
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const m = await api("GET", `/missions/${mission.id}`);
const tree = await api("GET", `/trees/${m.treeId}`);
console.log(`\nTree (${tree.nodes.length} runs, $${tree.totalCostUsd.toFixed(4)}):`);
for (const n of tree.nodes) {
  const extra = [n.review ? (n.review.approved ? "approved" : "changes requested") : "", n.mergedAt ? "merged" : "", n.prUrl ?? ""].filter(Boolean).join(", ");
  console.log(`${"  ".repeat(n.depth)}- ${n.agentName} (${n.kind === "review" ? "reviewer" : n.agentRole}) ${n.status} · ${n.turns} turns · $${n.costUsd.toFixed(4)}${extra ? ` · ${extra}` : ""}${n.error ? ` · ${n.error}` : ""}`);
}
console.log(`\nstage: ${m.stage} · ${Math.round((Date.now() - started) / 60_000)} min · docs: ${m.docs.map((d: any) => d.name).join(", ") || "none"} · PR: ${m.prUrl ?? "none"} (${m.prState ?? "-"})`);
if (m.retro) console.log(`retro:\n${m.retro}`);
process.exit(m.stage === "done" ? 0 : 1);
