#!/usr/bin/env bun
/**
 * P3 acceptance against a running hived with real models (HIVE_PLAN.md §12, P3):
 *  A. two dev agents fix independent bugs from one group message while a third agent's DM is not blocked;
 *  B. two agents discuss in the group and post a conclusion;
 *  C. two agents told to message each other forever are paused by the chain budget.
 *
 *   HIVE_PASSWORD=... bun evals/runner/p3-acceptance.ts --url http://127.0.0.1:4319 --endpoint OpenRouter --model qwen/qwen3.8-omni-flash
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

interface Msg { id: number; authorKind: string; authorName: string; body: string; createdAt: number }
interface Agent { id: string; name: string; state: string }

const log = (s: string) => process.stdout.write(`${s}\n`);
const messages = async (channelId: string) => (await api<{ messages: Msg[] }>("GET", `/channels/${channelId}/messages?limit=200`)).messages;

async function waitIdle(ids: string[], timeoutMs = 15 * 60_000): Promise<void> {
  const start = Date.now();
  await Bun.sleep(2500);
  while (Date.now() - start < timeoutMs) {
    const agents = await api<Agent[]>("GET", "/agents");
    if (agents.filter((a) => ids.includes(a.id)).every((a) => a.state === "idle")) return;
    await Bun.sleep(3000);
  }
  throw new Error("agents did not become idle in time");
}

async function main(): Promise<void> {
  await api("POST", "/auth/login", { username: process.env.HIVE_USER ?? "admin", password: process.env.HIVE_PASSWORD });
  const endpoint = (await api<{ id: string; name: string }[]>("GET", "/endpoints")).find((e) => e.name === opts.endpoint);
  if (!endpoint) throw new Error("endpoint not found");
  let workstations = await api<{ id: string; osUser: string }[]>("GET", "/workstations");
  if (!workstations.some((w) => w.osUser === "ws-2")) {
    await api("POST", "/workstations", { name: "Bench 2", osUser: "ws-2" });
    workstations = await api("GET", "/workstations");
  }
  const ws = (u: string) => workstations.find((w) => w.osUser === u)!.id;
  const comms = { toolpackId: "core.communication", toolName: "*" };
  const make = async (name: string, role: string, packs: string[], workstation?: string): Promise<Agent> => {
    const agent = await api<Agent>("POST", "/agents", {
      name, role, endpointId: endpoint.id, modelId: opts.model, thinkingLevel: "low",
      instructions: "Be concise. Follow the person's instructions exactly.",
      grants: [comms, ...packs.map((p) => ({ toolpackId: p, toolName: "*" }))],
    });
    if (workstation) await api("PUT", `/agents/${agent.id}/workstation`, { workstationId: ws(workstation) });
    return agent;
  };
  const suffix = Date.now().toString(36).slice(-4);
  const ana = await make(`Ana-${suffix}`, "developer", ["core.workstation"], "ws-1");
  const ben = await make(`Ben-${suffix}`, "developer", ["core.workstation"], "ws-2");
  const cleo = await make(`Cleo-${suffix}`, "assistant", []);
  const ping = await make(`Ping-${suffix}`, "player", ["core.colleagues"]);
  const pong = await make(`Pong-${suffix}`, "player", ["core.colleagues"]);
  const all = [ana, ben, cleo, ping, pong];
  const results: Record<string, string> = {};

  // A. Parallel work in a group while a DM to a third agent stays responsive.
  const crew = await api<{ id: string }>("POST", "/channels/groups", { title: `Crew ${suffix}`, agentIds: [ana.id, ben.id] });
  const t0 = Date.now();
  await api("POST", `/channels/${crew.id}/messages`, {
    body: `@${ana.name} fix the failing test test/chunk.test.ts in hive-sandbox using ws_checkout slug "p3-chunk-${suffix}". ` +
      `@${ben.name} fix test/backoff.test.ts using slug "p3-backoff-${suffix}". Do not edit tests. Each of you: run the test, git_commit, git_push, pr_create, then reply here with your PR URL.`,
  });
  await Bun.sleep(4000);
  const cleoDm = await api<{ id: string }>("POST", "/channels/dm", { agentId: cleo.id });
  const askedAt = Date.now();
  await api("POST", `/channels/${cleoDm.id}/messages`, { body: "What is 17 * 23? Reply with just the number." });
  let cleoAnswer: Msg | undefined;
  while (!cleoAnswer && Date.now() - askedAt < 120_000) {
    await Bun.sleep(1500);
    cleoAnswer = (await messages(cleoDm.id)).find((m) => m.authorKind === "agent");
  }
  const devsBusyWhenCleoAnswered = (await api<Agent[]>("GET", "/agents")).filter((a) => [ana.id, ben.id].includes(a.id) && a.state !== "idle").length;
  results.cleo = cleoAnswer ? `answered "${cleoAnswer.body.trim()}" in ${((cleoAnswer.createdAt - askedAt) / 1000).toFixed(1)}s while ${devsBusyWhenCleoAnswered}/2 devs were still busy` : "no answer";
  await waitIdle([ana.id, ben.id]);
  const pushes = [...(await api<{ status: string; prUrl: string | null; branch: string }[]>("GET", `/agents/${ana.id}/pushes`)), ...(await api<{ status: string; prUrl: string | null; branch: string }[]>("GET", `/agents/${ben.id}/pushes`))];
  const prs = pushes.filter((p) => p.prUrl).map((p) => p.prUrl!);
  results.parallel = `${prs.length}/2 PRs in ${Math.round((Date.now() - t0) / 1000)}s: ${prs.join(", ")}`;
  results.groupReplies = (await messages(crew.id)).filter((m) => m.authorKind === "agent").map((m) => `${m.authorName}: ${m.body.slice(0, 100).replace(/\n/g, " ")}`).join(" | ");

  // B. Discussion with a conclusion.
  await api("POST", `/channels/${crew.id}/messages`, {
    body: `@${ana.name} @${ben.name} Quick design discussion: should backoffDelay add random jitter? ${ana.name}: give your view in one or two sentences and ask ${ben.name} by @mentioning him. ` +
      `${ben.name}: when asked, reply to ${ana.name} with your view and @mention her. ${ana.name}: after ${ben.name} answers, post one final line starting with "Conclusion:". Do not use workstation tools.`,
  });
  await waitIdle([ana.id, ben.id]);
  const discussion = (await messages(crew.id)).filter((m) => m.id > 0 && m.authorKind !== "user").slice(-6);
  const conclusion = discussion.find((m) => /conclusion:/i.test(m.body));
  results.discussion = `${discussion.filter((m) => m.authorKind === "agent").length} agent messages; conclusion: ${conclusion ? conclusion.body.replace(/\n/g, " ").slice(0, 160) : "none"}`;

  // C. Endless ping-pong gets paused.
  const pingDm = await api<{ id: string }>("POST", "/channels/dm", { agentId: ping.id });
  await api("POST", `/channels/${pingDm.id}/messages`, {
    body: `Play a counting game with ${pong.name}: use message_agent to send ${pong.name} the number 1 and tell him the rules: whoever receives a number replies to the other with the next number, forever. Never stop on your own.`,
  });
  await waitIdle([ping.id, pong.id]);
  const between = (await api<{ id: string; kind: string; members: { id: string }[] }[]>("GET", "/channels"))
    .find((c) => c.kind === "agent_dm" && c.members.some((m) => m.id === ping.id) && c.members.some((m) => m.id === pong.id));
  const loop = between ? await messages(between.id) : [];
  const agentMsgs = loop.filter((m) => m.authorKind === "agent").length;
  const paused = loop.find((m) => m.authorKind === "system" && /paused/i.test(m.body));
  results.loop = `${agentMsgs} agent messages, ${paused ? `paused: "${paused.body}"` : "NOT paused"}`;

  const usage = await Promise.all(all.map((a) => api<{ costUsd: number; inputTokens: number; outputTokens: number }>("GET", `/agents/${a.id}/usage`)));
  results.cost = `$${usage.reduce((s, u) => s + u.costUsd, 0).toFixed(4)} (${usage.reduce((s, u) => s + u.inputTokens, 0)} in / ${usage.reduce((s, u) => s + u.outputTokens, 0)} out)`;

  for (const [k, v] of Object.entries(results)) log(`${k}: ${v}`);
  for (const url of prs) Bun.spawnSync(["gh", "pr", "close", url, "--delete-branch"]);
  if (!opts.keep) for (const a of all) await api("DELETE", `/agents/${a.id}`);
}

await main();
