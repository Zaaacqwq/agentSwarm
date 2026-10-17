import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { MissionView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";
import { OTHER_ID, OWNER_ID, WEBHOOK_SECRET, created, prompted, webhook } from "./fake-linear.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const docsOf = (c: TranscriptContext) => /Mission documents go in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const commitPush = (message: string) => [call("git_commit", { message }), call("git_push", {})];

/** Linear set up and installed, the demo repository connected to the Linear project "lp-demo". */
async function linearReady(h: Harness, opts: { maxActive?: number } = {}): Promise<{ cookie: string; projectId: string }> {
  const { cookie, projectId } = await h.ready();
  const set = await h.api("PUT", "/api/linear", {
    clientId: "client-id-123", clientSecret: "client-secret-456", webhookSecret: WEBHOOK_SECRET, ownerUserId: OWNER_ID,
    sandboxProjectId: "lp-sandbox", ideasProjectId: "lp-ideas", maxActive: opts.maxActive ?? 3,
  }, cookie);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const connect = await h.api("GET", "/api/linear/connect", undefined, cookie);
  const url = new URL(connect.body.url);
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("scope"), "read,write,app:assignable,app:mentionable");
  // The callback comes back without the session cookie (a cross-site navigation): the state is what counts.
  const cb = await h.app.inject({ method: "GET", url: `/api/linear/callback?code=the-code&state=${url.searchParams.get("state")}`, headers: { host: "127.0.0.1:4399" } });
  assert.match(cb.body, /Linear is connected/);
  const profile = await h.api("PUT", `/api/projects/${projectId}/profile`, { profile: { test: "node --test" }, linearProjectId: "lp-demo" }, cookie);
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  return { cookie, projectId };
}

async function send(h: Harness, payload: Record<string, unknown>): Promise<void> {
  assert.equal(await webhook(h.linearWebhook, payload), 200);
  const pending = () => (h.db.sqlite.prepare("select count(*) as n from linear_events where processed_at is null").get() as { n: number }).n;
  await until(() => pending() === 0);
  await h.services.linearBridge.idle();
}

const missionOf = (h: Harness, sessionId: string): MissionView | null => {
  const row = h.db.sqlite.prepare("select mission_id from linear_sessions where session_id = ?").get(sessionId) as { mission_id: string | null } | undefined;
  return row?.mission_id ? h.services.missions.view(row.mission_id) : null;
};

async function stageOf(h: Harness, sessionId: string, wanted: MissionView["stage"]): Promise<MissionView> {
  await until(() => missionOf(h, sessionId)?.stage === wanted, 30_000).catch(() => {
    const m = missionOf(h, sessionId);
    throw new Error(`mission is ${m?.stage} (lead ${m?.leadStatus}, error ${m?.error}), wanted ${wanted}`);
  });
  await h.services.linearBridge.idle();
  return missionOf(h, sessionId)!;
}

describe("Linear", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("the webhook takes only signed, fresh deliveries, each once; settings never give secrets back", async () => {
    h = await harness();
    const { cookie } = await linearReady(h);
    const issue = h.linear.addIssue({ title: "Nothing", projectId: "lp-elsewhere" });
    assert.equal(await webhook(h.linearWebhook, created("s-0", issue.id), { secret: "wrong-secret-value" }), 401);
    assert.equal(await webhook(h.linearWebhook, created("s-0", issue.id), { at: Date.now() - 120_000 }), 401, "a replay");
    assert.equal((await h.linearWebhook.inject({ method: "POST", url: "/linear/webhook", payload: "{}", headers: { "content-type": "application/json" } })).statusCode, 401);
    assert.equal((await h.linearWebhook.inject({ method: "GET", url: "/api/health" })).statusCode, 404, "nothing else is reachable on this port");
    assert.equal(await webhook(h.linearWebhook, created("s-0", issue.id), { delivery: "d-1" }), 200);
    assert.equal(await webhook(h.linearWebhook, created("s-0", issue.id), { delivery: "d-1" }), 200);
    await h.services.linearBridge.idle();
    assert.equal((h.db.sqlite.prepare("select count(*) as n from linear_events").get() as { n: number }).n, 1, "a redelivery is stored once");
    // Unconnected project: refused, with the reason in the ticket.
    await until(() => h.linear.in("s-0").some((a) => a.content.type === "error"));
    assert.match(JSON.stringify(h.linear.in("s-0")), /not connected to a repository/);
    const status = (await h.api("GET", "/api/linear", undefined, cookie)).body;
    assert.equal(status.connected, true);
    assert.equal(status.organization, "Zac");
    const everything = JSON.stringify([status, h.db.sqlite.prepare("select * from settings").all(), h.db.sqlite.prepare("select * from audit_log").all()]);
    for (const secret of ["client-secret-456", WEBHOOK_SECRET, "lin-access-1", "lin-refresh-1"]) assert.ok(!everything.includes(secret), secret);
    // A stale or forged OAuth state is refused.
    const forged = await h.app.inject({ method: "GET", url: "/api/linear/callback?code=x&state=forged", headers: { host: "127.0.0.1:4399" } });
    assert.match(forged.body, /expired/);
  });

  test("a bug ticket: only the owner is obeyed, the plan is approved in the ticket, and the ticket follows the mission to Done", async () => {
    h = await harness({ prPollMs: 100_000 });
    await linearReady(h);
    const stranger = h.linear.addIssue({ title: "Not yours", projectId: "lp-demo" });
    await send(h, created("s-stranger", stranger.id, OTHER_ID));
    assert.match(JSON.stringify(h.linear.in("s-stranger")), /only takes tickets from its owner/);
    assert.equal(missionOf(h, "s-stranger"), null);

    let planned = "";
    h.scriptAgents({
      Dev: [
        call("stage_done", { summary: "square(3) returns 6, should be 9." }),
        call("ask_user", { question: "Should square(-2) be 4?" }),
        (c) => {
          planned = JSON.stringify(c.messages.at(-1));
          return call("ws_write", { path: `${docsOf(c)}/plan.md`, content: "# Plan\nFix square; the test proves it.\n" });
        },
        ...commitPush("ZAC-2: plan"), call("request_approval", { summary: "Cause: + instead of *. Fix math.js." }),
        call("ws_edit", { path: "math.js", old_text: "x + x", new_text: "x * x" }), ...commitPush("ZAC-2: fix square"), call("stage_done", { summary: "Fixed." }),
        writeDoc("acceptance.md", "# Acceptance\nnode --test passes.\n"), ...commitPush("ZAC-2: acceptance"),
        call("open_pull_request", { title: "Fix square", body: "square multiplied wrongly." }), call("stage_done", { summary: "PR open." }),
        call("stage_done", { summary: "Small bug, quick fix." }),
      ],
    });
    const issue = h.linear.addIssue({ title: "square is wrong", description: "square(3) gives 6", projectId: "lp-demo", labels: ["Bug"], priority: 2 });
    await send(h, created("s-bug", issue.id));
    const first = h.linear.in("s-bug")[0]!;
    assert.deepEqual(first.content, { type: "thought", body: "Got it — reading the ticket." }, "acknowledged before anything slow");
    const m = missionOf(h, "s-bug")!;
    assert.equal(m.kind, "bug");
    assert.equal(m.origin, "linear");
    assert.equal(m.title, `${issue.identifier} square is wrong`);
    assert.deepEqual(m.linear, { key: issue.identifier, url: issue.url });
    assert.equal(h.linear.stateOf(issue.id), "In Progress");

    // The lead's question arrives as an elicitation; the answer goes back as a prompt.
    await until(() => h.linear.in("s-bug").some((a) => a.content.type === "elicitation"));
    assert.match(JSON.stringify(h.linear.in("s-bug").find((a) => a.content.type === "elicitation")), /square\(-2\)/);
    await send(h, prompted("s-bug", "Yes, 4.", undefined, OTHER_ID));
    assert.equal(planned, "", "a stranger's reply is ignored");
    await send(h, prompted("s-bug", "Yes, 4."));
    const gate = await stageOf(h, "s-bug", "awaiting_approval");
    assert.match(planned, /Yes, 4\./);
    const approval = h.linear.in("s-bug").find((a) => a.content.type === "elicitation" && "body" in a.content && a.content.body.includes("ready for your approval"))!;
    assert.deepEqual(approval.opts.select?.map((o) => o.value), ["approve", "Request changes"]);
    assert.match(JSON.stringify(approval), /plan\.md/);
    // The checklist shows where it is.
    const plan = h.linear.sessionUpdates.filter((u) => u.sessionId === "s-bug").at(-1)!.plan!;
    assert.equal(plan.find((s) => s.status === "inProgress")?.content, "You approve the plan");
    assert.ok(gate.waitingForYou);

    await send(h, prompted("s-bug", "Request changes"));
    assert.match(JSON.stringify(h.linear.in("s-bug").at(-1)), /What should change/);
    assert.equal(missionOf(h, "s-bug")!.stage, "awaiting_approval", "the button alone changes nothing");
    await send(h, prompted("s-bug", "approve"));
    const merge = await stageOf(h, "s-bug", "awaiting_merge");
    assert.equal(h.linear.stateOf(issue.id), "In Review");
    const pr = h.pullRequests.at(-1)!;
    assert.match(pr.title, new RegExp(`^${issue.identifier} Fix square`));
    assert.match(pr.body, new RegExp(`Fixes ${issue.identifier}`));
    assert.match(merge.branch, /zac-2/i, "the branch carries the ticket key");
    const urls = h.linear.sessionUpdates.filter((u) => u.sessionId === "s-bug").at(-1)!.externalUrls!;
    assert.ok(urls.some((u) => u.label === "Pull request" && u.url === merge.prUrl));
    assert.ok(urls.some((u) => u.label === "plan.md" && u.url.startsWith("https://github.com/")));

    h.prStates.set(1, "merged");
    await h.services.watcher.poll();
    await stageOf(h, "s-bug", "done");
    await until(() => h.linear.in("s-bug").some((a) => a.content.type === "response"));
    assert.equal(h.linear.stateOf(issue.id), "Done");
    const answer = JSON.stringify(h.linear.in("s-bug").find((a) => a.content.type === "response"));
    assert.match(answer, /Small bug, quick fix/);
    assert.match(answer, /Merged: https:\/\/github\.com/);
    assert.match(answer, /Cost: \$/);
    const log = execFileSync("/usr/bin/git", ["log", "--format=%s", merge.branch], { cwd: h.remote }).toString();
    assert.match(log, new RegExp(`${issue.identifier}: fix square`));
  });

  test("tickets beyond maxActive wait by priority; stop cancels a mission or takes a ticket off the queue", async () => {
    h = await harness();
    await linearReady(h, { maxActive: 1 });
    h.scriptAgents({ Dev: [call("ask_user", { question: "Which file?" })] });
    const a = h.linear.addIssue({ title: "First", projectId: "lp-demo", priority: 3 });
    const low = h.linear.addIssue({ title: "Low", projectId: "lp-demo", priority: 4 });
    const urgent = h.linear.addIssue({ title: "Urgent", projectId: "lp-demo", priority: 1 });
    await send(h, created("s-a", a.id));
    await send(h, created("s-low", low.id));
    await send(h, created("s-urgent", urgent.id));
    assert.ok(missionOf(h, "s-a"));
    assert.equal(missionOf(h, "s-low"), null);
    assert.match(JSON.stringify(h.linear.in("s-urgent")), /Queued: 1 tickets are being worked on; 0 ahead/);
    assert.match(JSON.stringify(h.linear.in("s-low").at(-1)), /Queued/);

    // Stopping the low one in the queue: removed, nothing started.
    await send(h, prompted("s-low", "", "stop"));
    assert.match(JSON.stringify(h.linear.in("s-low").at(-1)), /Removed from the queue/);
    // Stopping the running one: cancelled, and the urgent one starts.
    await until(() => missionOf(h, "s-a")?.waitingForYou === true);
    await send(h, prompted("s-a", "", "stop"));
    await stageOf(h, "s-a", "cancelled");
    assert.match(JSON.stringify(h.linear.in("s-a")), /Stopped during intake/);
    await until(() => h.linear.stateOf(a.id) === "Canceled");
    await until(() => missionOf(h, "s-urgent") !== null);
    assert.equal(missionOf(h, "s-low"), null);
  });

  test("a sandbox experiment runs in a local repository, reports back in the ticket, and becomes a project on 立项", async () => {
    h = await harness();
    await linearReady(h);
    h.scriptAgents({
      Lead: [
        call("stage_done", { summary: "Try a 2x faster square." }),
        call("ws_write", { path: "bench.js", content: "console.log('ok');\n" }),
        writeDoc("results.md", "# Results\nThe fast square is 2x faster.\n"), ...commitPush("Experiment"),
        call("stage_done", { summary: "It works: 2x faster." }),
      ],
    });
    const issue = h.linear.addIssue({ title: "Faster square", projectId: "lp-sandbox" });
    await send(h, created("s-exp", issue.id));
    const m = await stageOf(h, "s-exp", "done");
    assert.equal(m.kind, "experiment");
    const project = h.services.projects.view(m.projectId);
    assert.equal(project.kind, "local");
    assert.equal(h.pullRequests.length, 0);
    await until(() => h.linear.in("s-exp").some((a) => a.content.type === "response"));
    const answer = JSON.stringify(h.linear.in("s-exp").find((a) => a.content.type === "response"));
    assert.match(answer, /2x faster/);
    assert.match(answer, /results\.md/);
    assert.match(answer, /立项/);
    assert.equal(h.linear.stateOf(issue.id), "Done");
    assert.ok(!h.remoteBranches().some((b) => b.includes("faster")), "nothing reached GitHub");

    h.scriptAgents({ Lead: [call("ask_user", { question: "Ready to plan the real thing?" })] });
    await send(h, prompted("s-exp", "立项"));
    await until(() => missionOf(h, "s-exp")?.id !== m.id, 30_000);
    const next = missionOf(h, "s-exp")!;
    assert.equal(next.kind, "feature");
    const real = h.services.projects.view(next.projectId);
    assert.equal(real.kind, "github");
    assert.match(real.githubRepo, /^tester\/faster-square/);
    assert.equal(real.linearProjectId, h.linear.createdProjects[0]!.id);
    assert.equal(h.linear.issues.get(issue.id)!.projectId, h.linear.createdProjects[0]!.id, "the ticket moved to the new Linear project");
    const files = execFileSync("/usr/bin/git", ["ls-tree", "-r", "--name-only", "main"], { cwd: h.services.projects.get(real.id).mirrorPath }).toString();
    assert.match(files, /results\.md/, "what the experiment found starts the new repository");
    assert.match(next.intent, /started as an experiment/);
  });
});
