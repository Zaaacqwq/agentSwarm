import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary: string) => call("report", { summary, tests: "node --test: ok", unfinished: [] });
const TOKEN = "sk-ant-oat01-fake-claude-token-for-tests-0123456789";

function ids(context: TranscriptContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of context.messages) {
    const text = JSON.stringify((m as { content?: unknown }).content ?? "");
    for (const match of text.matchAll(/Spawned ([A-Za-z0-9-]+): id (run_[0-9a-f]+)/g)) out[match[1]!] = match[2]!;
  }
  return out;
}
const callWith = (name: string, args: (ids: Record<string, string>) => Args): FauxResponseFactory => (context) => call(name, args(ids(context)));
const lastText = (context: TranscriptContext) => JSON.stringify(context.messages.at(-1) ?? "");
const FIXED = "export const square = (x) => x * x;\n";

async function withClaude(h: Harness, cookie: string): Promise<void> {
  const res = await h.api("PUT", "/api/cli", { claudeToken: TOKEN }, cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function signInCodex(h: Harness, cookie: string, ws: string): Promise<void> {
  const res = await h.api("POST", `/api/cli/codex/${ws}/login`, undefined, cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await until(() => h.services.cli.status().codex.workstations.find((w) => w.workstationId === ws)?.login?.code === "FAKE-12345");
  h.cli.approveLogin();
  await until(() => h.services.cli.status().codex.workstations.find((w) => w.workstationId === ws)?.signedInAt !== null);
  await until(() => h.services.pool.list().find((w) => w.id === ws)?.status === "free");
}

describe("CLI workers", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("a Claude Code sub-agent fixes a bug, is sent back by review, continues its session, and is merged", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    h.cli.script([
      { write: [{ path: "math.js", content: FIXED }], commit: "Fix square", quota: { five: 0.3, seven: 0.1 }, usd: 0.12, report: { summary: "square now multiplies", tests: "node --test: 1 passed", unfinished: [] } },
      { write: [{ path: "edge.test.js", content: 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { square } from "./math.js";\ntest("zero", () => assert.equal(square(0), 0));\n' }], commit: "Test square(0)", usd: 0.04 },
    ]);
    let spawnDescription = "";
    let firstReport = "";
    const script = h.scriptAgents({
      Dev: [
        (context) => {
          spawnDescription = JSON.stringify(context.messages.filter((m) => m.role === "system"));
          return call("spawn_agent", { name: "Fix", role: "developer", brief: "math.js square() is wrong; fix it so the tests pass.", runtime: "claude_code" });
        },
        call("wait_agents", {}),
        (context) => {
          firstReport = lastText(context);
          return call("review_agent", { id: ids(context).Fix! });
        },
        callWith("message_agent", (i) => ({ id: i.Fix!, text: "Review: add a test for square(0)." })),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.Fix! })),
        callWith("merge_agent", (i) => ({ id: i.Fix! })),
        call("ws_bash", { command: "node --test" }),
        call("git_push", {}),
        call("open_pull_request", { title: "Fix square", body: "Done by Claude Code." }),
        report("fixed by the CLI worker"),
      ],
      "Fix-review": [
        call("review_verdict", { approved: false, comments: "Add a test for square(0)." }),
        call("ws_bash", { command: "node --test" }),
        call("review_verdict", { approved: true, comments: "Good." }),
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Square", brief: "Fix square with a sub-agent." }, cookie)).body;
    const done = await h.services.runs.settled(root.id, 60_000);
    assert.equal(done.status, "succeeded", `${done.error} / left: ${script.remaining()}`);
    assert.deepEqual(script.remaining(), []);

    const tree = (await h.api("GET", `/api/trees/${root.treeId}`, undefined, cookie)).body;
    const fix = tree.nodes.find((n: any) => n.agentName === "Fix");
    assert.equal(fix.runtime, "claude_code");
    assert.equal(fix.status, "succeeded");
    assert.equal(fix.costUsd, 0, "a subscription run spends nothing from the budget");
    assert.equal(fix.budgetUsd, 0);
    assert.ok(Math.abs(fix.estimatedUsd - 0.16) < 1e-9, `estimated ${fix.estimatedUsd}`);
    assert.ok(fix.mergedAt);
    assert.equal(tree.nodes.filter((n: any) => n.kind === "review").every((n: any) => n.runtime === "native"), true);
    assert.match(spawnDescription, /claude_code: available/);
    assert.match(firstReport, /square now multiplies/);
    assert.match(firstReport, /node --test: 1 passed/);

    // The second execution continued the first session, with the reviewer's request.
    const calls = h.cli.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.resume, null);
    assert.match(calls[0]!.prompt, /square\(\) is wrong/);
    assert.match(calls[0]!.prompt, /Do not push/);
    const session = h.services.runs.get(fix.id).cliSession;
    assert.ok(session);
    assert.equal(calls[1]!.resume, session);
    assert.match(calls[1]!.prompt, /add a test for square\(0\)/);
    assert.ok(calls.every((c) => c.tokenLength === TOKEN.length && !c.tokenInEnv));

    // Both commits went out through the Relay and into the PR branch.
    const log = execFileSync("/usr/bin/git", ["log", "--format=%s", root.branch], { cwd: h.remote }).toString();
    assert.match(log, /Fix square/);
    assert.match(log, /Test square\(0\)/);
    assert.equal(h.pullRequests.length, 1);

    // The dashboard sees the CLI's work as ordinary run events, and the token appears nowhere.
    const events = (await h.api("GET", `/api/runs/${fix.id}/events`, undefined, cookie)).body;
    const types = new Set(events.map((e: any) => e.type));
    for (const t of ["tool_start", "tool_end", "push", "status"]) assert.ok(types.has(t), t);
    assert.ok(events.some((e: any) => e.type === "tool_start" && e.data.name === "Write"));
    const everything = JSON.stringify([events, h.db.sqlite.prepare("select * from runs").all(), h.db.sqlite.prepare("select * from audit_log").all(), h.db.sqlite.prepare("select value from settings").all()]);
    assert.ok(!everything.includes(TOKEN), "the token is never stored or shown in clear");
    const status = (await h.api("GET", "/api/cli", undefined, cookie)).body;
    assert.equal(status.claude.hasToken, true);
    assert.equal(status.claude.quota.fiveHour, 0.3);
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.ok(h.services.pool.list().every((w) => w.status === "free"));
  });

  test("Codex runs only where it is signed in; changes it leaves uncommitted are committed for it", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await signInCodex(h, cookie, "ws-2");
    h.cli.script([{ write: [{ path: "math.js", content: FIXED }], report: { summary: "fixed, not committed", tests: "node --test ok", unfinished: [] } }]);
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "Cx", role: "developer", brief: "Fix square() in math.js so the tests pass.", runtime: "codex" }),
        call("wait_agents", {}),
        report("codex did it"),
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Codex", brief: "Fix with Codex." }, cookie)).body;
    const done = await h.services.runs.settled(root.id, 60_000);
    assert.equal(done.status, "succeeded", String(done.error));
    const cx = h.services.runs.tree(root.treeId!).nodes.find((n) => n.agentName === "Cx")!;
    assert.equal(cx.status, "succeeded", String(cx.error));
    assert.equal(cx.workstationId, "ws-2");
    const codexHome = h.cli.calls()[0]!.codexHome!;
    assert.match(codexHome, /\/ws-2\/\.homes\/[^/]+\/\.codex$/, "a copy of ws-2's sign-in, in the run's own space");
    const log = execFileSync("/usr/bin/git", ["log", "-1", "--format=%s", cx.branch], { cwd: h.remote }).toString();
    assert.match(log, /Uncommitted changes left by Codex/);
    assert.ok(cx.tokensIn > 0);
  });

  test("an unavailable runtime is refused at spawn with the reason; a used-up quota stops new Claude Code runs", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let refusal = "";
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "A", role: "developer", brief: "Anything at all, for the test.", runtime: "claude_code" }),
        (context) => {
          refusal = lastText(context);
          return report("could not spawn");
        },
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "No token", brief: "Try the CLI." }, cookie)).body;
    await h.services.runs.settled(root.id, 30_000);
    assert.match(refusal, /claude_code is not available: Claude Code has no token yet/);
    assert.equal(h.cli.calls().length, 0);

    await withClaude(h, cookie);
    h.services.cli.recordQuota({ fiveHour: 0.85, fiveHourResetsAt: Date.now() + 3_600_000, sevenDay: 0.2, sevenDayResetsAt: Date.now() + 86_400_000, status: "allowed", at: Date.now() });
    const a = h.services.cli.availability("claude_code");
    assert.equal(a.ok, false);
    assert.match(!a.ok ? a.reason : "", /5-hour window is 85% used \(limit 80%\)/);
    assert.match(h.services.cli.runtimesNote(), /claude_code: unavailable/);
    assert.match(h.services.cli.runtimesNote(), /codex: unavailable \(Codex is not signed in/);
    // A quota that has reset no longer blocks.
    h.services.cli.recordQuota({ fiveHour: 0.85, fiveHourResetsAt: Date.now() - 1000, sevenDay: 0.2, sevenDayResetsAt: Date.now() + 86_400_000, status: "allowed", at: Date.now() + 1 });
    assert.equal(h.services.cli.availability("claude_code").ok, true);
    // Switched off in the settings.
    await h.api("PUT", "/api/cli", { claudeEnabled: false }, cookie);
    assert.equal(h.services.cli.availability("claude_code").ok, false);
    assert.equal((await h.api("PUT", "/api/cli", { claudeToken: "not-a-claude-token-at-all" }, cookie)).status, 400);
  });

  test("cancelling a CLI run kills it and frees the workstation; a lost session starts a new one", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    h.cli.script([{ longLived: true, sleepMs: 60_000 }]);
    h.scriptAgents({ Dev: [call("spawn_agent", { name: "Slow", role: "developer", brief: "Take a long time doing this.", runtime: "claude_code" }), call("wait_agents", {})] });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Slow", brief: "Spawn a slow CLI." }, cookie)).body;
    await until(() => h.cli.sleeperPid() !== null, 20_000);
    const slow = () => h.services.runs.tree(root.treeId!).nodes.find((n) => n.agentName === "Slow")!;
    await until(() => slow().status === "running");
    await h.api("POST", `/api/runs/${root.id}/cancel`, undefined, cookie);
    await h.services.runs.settled(slow().id, 20_000);
    assert.equal(slow().status, "cancelled");
    await until(() => h.services.pool.list().every((w) => w.status === "free"), 20_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(h.cli.sleeperPid()!, 0), "the CLI's processes are gone");

    // A follow-up whose session the CLI no longer has: it starts over with the whole story.
    h.cli.script([{ failResume: true }, { write: [{ path: "math.js", content: FIXED }], commit: "Fix square again" }]);
    h.db.sqlite.prepare("update runs set cli_session = 'aaaaaaaa-0000-0000-0000-000000000000', status = 'failed' where id = ?").run(slow().id);
    h.services.runs.message("admin", slow().id, "Please fix square() now.");
    const again = await h.services.runs.settled(slow().id, 30_000);
    assert.equal(again.status, "succeeded", String(again.error));
    const calls = h.cli.calls().slice(-2);
    assert.equal(calls[0]!.resume, "aaaaaaaa-0000-0000-0000-000000000000");
    assert.equal(calls[1]!.resume, null);
    assert.match(calls[1]!.prompt, /earlier session is gone/);
    assert.match(calls[1]!.prompt, /Please fix square\(\) now/);
  });

  test("a message to a working CLI sub-agent continues the same execution; its parent hears back once", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    h.cli.script([{ sleepMs: 1500, write: [{ path: "a.txt", content: "a" }], commit: "a" }, { write: [{ path: "b.txt", content: "b" }], commit: "b", report: { summary: "a and b", tests: "-", unfinished: [] } }]);
    let results = "";
    const script = h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "Busy", role: "developer", brief: "Write a.txt, nothing else, for this test.", runtime: "claude_code" }),
        call("wait_agents", {}),
        (context) => {
          results = lastText(context);
          return report("done");
        },
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Steer", brief: "Steer a CLI child." }, cookie)).body;
    const busy = () => h.services.runs.tree(root.treeId!).nodes.find((n) => n.agentName === "Busy")!;
    await until(() => h.cli.calls().length === 1, 20_000);
    h.services.runs.message("admin", busy().id, "Also write b.txt.");
    const done = await h.services.runs.settled(root.id, 60_000);
    assert.equal(done.status, "succeeded", `${done.error} / ${script.remaining()}`);
    assert.deepEqual(script.remaining(), []);
    const calls = h.cli.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.resume, h.services.runs.get(busy().id).cliSession);
    assert.match(calls[1]!.prompt, /Also write b\.txt/);
    assert.match(results, /a and b/, "the parent got the report after the follow-up, not before");
  });

  test("a follow-up without a session still tells the CLI its task", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    h.cli.script([{ crash: true }, { write: [{ path: "math.js", content: FIXED }], commit: "Fix square" }]);
    h.scriptAgents({ Dev: [call("spawn_agent", { name: "Crashy", role: "developer", brief: "Fix square() in math.js so the tests pass.", runtime: "claude_code" }), call("wait_agents", {}), report("tried")] });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Crash", brief: "A CLI that crashes first." }, cookie)).body;
    await h.services.runs.settled(root.id, 30_000);
    const crashy = h.services.runs.tree(root.treeId!).nodes.find((n) => n.agentName === "Crashy")!;
    assert.equal(crashy.status, "failed");
    assert.match(crashy.error ?? "", /exited 2: fatal: could not start/);
    assert.equal(h.services.runs.get(crashy.id).cliSession, null);
    h.services.runs.message("admin", crashy.id, "Try again.");
    const again = await h.services.runs.settled(crashy.id, 30_000);
    assert.equal(again.status, "succeeded", String(again.error));
    const second = h.cli.calls()[1]!;
    assert.equal(second.resume, null);
    assert.match(second.prompt, /Fix square\(\) in math\.js/, "the brief");
    assert.match(second.prompt, /Try again\./, "and the latest message");
  });

  test("a queued CLI run waits while the quota is used up, instead of failing", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    await h.api("PUT", "/api/cli", { maxConcurrent: 1 }, cookie);
    h.cli.script([{ sleepMs: 1500, write: [{ path: "a.txt", content: "a" }], commit: "a" }, { write: [{ path: "b.txt", content: "b" }], commit: "b" }]);
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "First", role: "developer", brief: "Write a.txt for this test.", runtime: "claude_code" }),
        call("spawn_agent", { name: "Second", role: "developer", brief: "Write b.txt for this test.", runtime: "claude_code" }),
        call("wait_agents", {}),
        report("both"),
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Quota", brief: "Two CLIs, quota runs out." }, cookie)).body;
    const node = (name: string) => h.services.runs.tree(root.treeId!).nodes.find((n) => n.agentName === name);
    await until(() => node("Second")?.status === "queued" && node("First")?.status === "running", 20_000);
    h.services.cli.recordQuota({ fiveHour: 0.95, fiveHourResetsAt: Date.now() + 3_600_000, sevenDay: 0.1, sevenDayResetsAt: Date.now() + 86_400_000, status: "allowed", at: Date.now() });
    await until(() => node("First")?.status === "succeeded", 20_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(node("Second")!.status, "queued", "it waits for the window");
    h.services.cli.recordQuota({ fiveHour: 0.1, fiveHourResetsAt: Date.now() + 3_600_000, sevenDay: 0.1, sevenDayResetsAt: Date.now() + 86_400_000, status: "allowed", at: Date.now() + 1 });
    h.services.runs.schedule();
    const done = await h.services.runs.settled(root.id, 30_000);
    assert.equal(done.status, "succeeded", String(done.error));
    assert.equal(node("Second")!.status, "succeeded");
  });

  test("at most maxConcurrent runs of one CLI at a time; the rest wait their turn", async () => {
    h = await harness({ maxConcurrentRuns: 3 });
    const { cookie, agentId } = await h.ready();
    await withClaude(h, cookie);
    await h.api("PUT", "/api/cli", { maxConcurrent: 1 }, cookie);
    h.cli.script([{ sleepMs: 1500, write: [{ path: "a.txt", content: "a" }], commit: "a" }, { write: [{ path: "b.txt", content: "b" }], commit: "b" }]);
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "One", role: "developer", brief: "Write a.txt for this test.", runtime: "claude_code" }),
        call("spawn_agent", { name: "Two", role: "developer", brief: "Write b.txt for this test.", runtime: "claude_code" }),
        call("wait_agents", {}),
        report("both done"),
      ],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Two CLIs", brief: "Two at once." }, cookie)).body;
    let most = 0;
    const timer = setInterval(() => {
      most = Math.max(most, h.services.runs.tree(root.treeId!).nodes.filter((n) => n.runtime === "claude_code" && n.status === "running").length);
    }, 20);
    const done = await h.services.runs.settled(root.id, 60_000);
    clearInterval(timer);
    assert.equal(done.status, "succeeded", String(done.error));
    assert.equal(most, 1);
    assert.equal(h.cli.calls().length, 2);
  });
});
