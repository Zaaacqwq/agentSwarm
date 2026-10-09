#!/usr/bin/env bun
/**
 * P5 acceptance (HIVE_PLAN section 12): an operator agent does a low-risk task on a public web
 * admin page and reports back with a screenshot; the dangerous step (typing a password) waits for a
 * person's approval; meanwhile a dev agent runs a terminal task on another workstation.
 *
 *   HIVE_PASSWORD=... bun evals/runner/p5-acceptance.ts --url http://127.0.0.1:4319
 */
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

interface Approval { id: string; agentId: string; kind: string; scope: string; question: string; status: string; createdAt: number }
interface Message { id: number; authorKind: string; authorId: string; body: string; attachments: { id: string; mime: string; filename: string }[] }
interface Run { id: string; status: string; costUsd: number }

await api("POST", "/auth/login", { username: process.env.HIVE_USER ?? "admin", password: process.env.HIVE_PASSWORD });
const endpoint = (await api<{ id: string }[]>("GET", "/endpoints"))[0]!;
const workstations = await api<{ id: string; osUser: string }[]>("GET", "/workstations");
const sfx = Date.now().toString(36).slice(-3);
const agent = async (name: string, template: "operator" | "dev", osUser: string) => {
  const t = ROLE_TEMPLATES[template];
  const a = await api<{ id: string; name: string }>("POST", "/agents", { name, role: t.role, instructions: t.instructions, endpointId: endpoint.id, modelId: opts.model, thinkingLevel: "low", grants: t.grants });
  await api("PUT", `/agents/${a.id}/workstation`, { workstationId: workstations.find((w) => w.osUser === osUser)!.id });
  return a;
};
const op = await agent(`Opal${sfx}`, "operator", "ws-1");
const dev = await agent(`Dex${sfx}`, "dev", "ws-2");
const opDm = await api<{ id: string }>("POST", "/channels/dm", { agentId: op.id });
const devDm = await api<{ id: string }>("POST", "/channels/dm", { agentId: dev.id });
const started = Date.now();

await api("POST", `/channels/${opDm.id}/messages`, {
  body: [
    "Please check our demo admin login at https://the-internet.herokuapp.com/login.",
    "Read the page, then sign in with the demo account printed on that page, and confirm you reach the secure area.",
    `Reply here with what the secure area says, and post a browser screenshot of it to this chat (channel ${opDm.id}). Do not change anything else.`,
  ].join(" "),
});
await api("POST", `/channels/${devDm.id}/messages`, {
  body: `Check out hive-sandbox with slug p5-check-${sfx}, run \`bun test\` in it with ws_bash, and reply here with the pass/fail counts. Do not commit or push anything.`,
});

// A person watching the approvals: grants the operator's site write, records everything asked.
const asked: Approval[] = [];
const decided = new Set<string>();
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 12 * 60_000): Promise<T> {
  while (Date.now() - started < timeoutMs) {
    for (const a of await api<Approval[]>("GET", "/approvals?status=pending")) {
      if (decided.has(a.id) || a.createdAt < started) continue;
      decided.add(a.id);
      asked.push(a);
      const approve = a.agentId === op.id && a.kind === "browser_site" && a.scope.endsWith("herokuapp.com");
      await api("POST", `/approvals/${a.id}/decide`, approve ? { decision: "approve", minutes: 15 } : { decision: "deny" });
      console.log(`approval ${approve ? "granted" : "denied"}: [${a.kind}] ${a.question}`);
    }
    const v = await check();
    if (v) return v;
    await Bun.sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const replies = (channel: string, who: string) => api<{ messages: Message[] }>("GET", `/channels/${channel}/messages`).then((p) => p.messages.filter((m) => m.authorKind === "agent" && m.authorId === who));
await until("both agents to finish", async () => {
  const agents = await api<{ id: string; state: string }[]>("GET", "/agents");
  const idle = agents.filter((a) => a.id === op.id || a.id === dev.id).every((a) => a.state === "idle");
  return idle && (await replies(opDm.id, op.id)).length > 0 && (await replies(devDm.id, dev.id)).length > 0;
});

const opMsgs = await replies(opDm.id, op.id);
const devMsgs = await replies(devDm.id, dev.id);
const shots = await api<{ id: string; source: string }[]>("GET", `/agents/${op.id}/screenshots`);
const posted = opMsgs.flatMap((m) => m.attachments).filter((f) => f.mime === "image/jpeg");
const runs = async (id: string) => (await api<{ runs: Run[] }>("GET", `/agents/${id}/runs?limit=15`)).runs;
const [opRuns, devRuns] = await Promise.all([runs(op.id), runs(dev.id)]);
const text = opMsgs.map((m) => m.body).join("\n");

console.log("\n== operator");
console.log(text.slice(0, 600));
console.log(`secure area reached: ${/secure area/i.test(text)} · screenshots taken: ${shots.length} · screenshots posted: ${posted.length}`);
console.log(`approvals asked: ${asked.map((a) => `${a.kind}:${a.scope || "-"}`).join(", ") || "none"}`);
console.log(`runs: ${opRuns.map((r) => r.status).join(", ")} · $${opRuns.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
console.log("\n== dev (concurrent terminal task)");
console.log(devMsgs.map((m) => m.body).join("\n").slice(0, 400));
console.log(`runs: ${devRuns.map((r) => r.status).join(", ")} · $${devRuns.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
console.log(`\nwall time: ${Math.round((Date.now() - started) / 1000)}s`);
