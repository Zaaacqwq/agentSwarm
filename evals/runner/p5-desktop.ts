#!/usr/bin/env bun
/**
 * P5 desktop check on the real Mac: an operator agent asks for desktop control, a PERSON approves
 * it in the UI (this script never decides desktop approvals), then the agent reads TextEdit's
 * accessibility tree, types a line into a new document, posts a screenshot and releases control.
 *
 *   HIVE_PASSWORD=... bun evals/runner/p5-desktop.ts --url http://127.0.0.1:4319
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROLE_TEMPLATES } from "../../packages/core/src/contracts/tasks.ts";

const { values: opts } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:4318" }, model: { type: "string", default: "qwen/qwen3.8-omni-flash" } } });
const LINE = `Hello from Hive ${Date.now().toString(36).slice(-4)}`;

let cookie = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${opts.url}/api${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : null });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface Approval { id: string; agentId: string; kind: string; scope: string; status: string; decidedBy: string | null; createdAt: number }
interface Message { authorKind: string; authorId: string; body: string; attachments: { mime: string }[] }
interface Run { status: string; costUsd: number }

await api("POST", "/auth/login", { username: process.env.HIVE_USER ?? "admin", password: process.env.HIVE_PASSWORD });
const endpoint = (await api<{ id: string }[]>("GET", "/endpoints"))[0]!;
const ws = (await api<{ id: string; osUser: string }[]>("GET", "/workstations")).find((w) => w.osUser === "ws-1")!;
const t = ROLE_TEMPLATES.operator;
const op = await api<{ id: string; name: string }>("POST", "/agents", { name: `Desk${Date.now().toString(36).slice(-3)}`, role: t.role, instructions: t.instructions, endpointId: endpoint.id, modelId: opts.model, thinkingLevel: "low", grants: t.grants });
await api("PUT", `/agents/${op.id}/workstation`, { workstationId: ws.id });
const dm = await api<{ id: string }>("POST", "/channels/dm", { agentId: op.id });

// A blank TextEdit document in front, so the agent never has to launch apps itself. A file, not
// AppleScript: scripting TextEdit would need one more permission (Automation) for the terminal.
const docPath = join(mkdtempSync(join(tmpdir(), "hive-desktop-")), "hive-desktop-check.txt");
writeFileSync(docPath, "");
Bun.spawnSync(["/usr/bin/open", "-a", "TextEdit", docPath]);
await Bun.sleep(2000);

const started = Date.now();
await api("POST", `/channels/${dm.id}/messages`, {
  body: [
    "A blank TextEdit document (hive-desktop-check.txt) is open on this Mac.",
    "Ask for desktop control for 10 minutes, then read TextEdit's interface with desktop_ui,",
    `click into the document and type exactly: ${LINE}`,
    `Then post a desktop screenshot to this chat (channel ${dm.id}), release the desktop, and tell me what you did.`,
    "Do not save the document or touch any other app.",
  ].join(" "),
});

console.log(`>>> ${op.name} will ask for desktop control. Approve it yourself in Hive (the banner, the chat card, or This Mac).`);
let approval: Approval | undefined;
while (Date.now() - started < 15 * 60_000) {
  const mine = (await api<Approval[]>("GET", `/approvals?agentId=${op.id}`)).filter((a) => a.kind === "desktop");
  approval ??= mine[0];
  if (approval) approval = mine.find((a) => a.id === approval!.id) ?? approval;
  const agents = await api<{ id: string; state: string }[]>("GET", "/agents");
  const idle = agents.find((a) => a.id === op.id)?.state === "idle";
  const msgs = (await api<{ messages: Message[] }>("GET", `/channels/${dm.id}/messages`)).messages.filter((m) => m.authorKind === "agent" && m.authorId === op.id);
  if (idle && msgs.length > 0) break;
  await Bun.sleep(3000);
}

const msgs = (await api<{ messages: Message[] }>("GET", `/channels/${dm.id}/messages`)).messages.filter((m) => m.authorKind === "agent" && m.authorId === op.id);
const runs = (await api<{ runs: Run[] }>("GET", `/agents/${op.id}/runs?limit=15`)).runs;
const desk = await api<{ available: boolean; accessibility: boolean; holder: unknown }>("GET", "/desktop").catch((e) => ({ error: String(e) }));

console.log(`\napproval: ${approval ? `${approval.status} by ${approval.decidedBy ?? "-"}` : "never asked"}`);
console.log(`line to find in the screenshot and the agent's own desktop_ui reading: ${LINE}`);
console.log(`document (unsaved, close it without saving): ${docPath}`);
console.log(`screenshots posted: ${msgs.flatMap((m) => m.attachments).filter((f) => f.mime === "image/jpeg").length}`);
console.log(`desktop after the run: ${JSON.stringify(desk).slice(0, 200)}`);
console.log(`runs: ${runs.map((r) => r.status).join(", ")} · $${runs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
console.log(`\n${msgs.map((m) => m.body).join("\n").slice(0, 800)}`);
console.log(`\nwall time: ${Math.round((Date.now() - started) / 1000)}s`);
