import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { harness, type Harness } from "./harness.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary = "Fixed square") => call("report", { summary, tests: "1 passed", unfinished: [] });
const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("a run", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("fixes a bug in its own worktree, tests, commits and pushes through the Relay", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([
      call("ws_read", { path: "math.js" }),
      call("ws_edit", { path: "math.js", old_text: "x + x", new_text: "x * x" }),
      call("ws_bash", { command: "node --test" }),
      call("git_commit", { message: "Fix square" }),
      call("git_push", {}),
      report(),
    ]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Fix square", brief: "square(3) should be 9" }, cookie)).body;
    assert.match(run.branch, /^swarm\/demo\/fix-square-[0-9a-f]{6}$/);
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.report?.summary, "Fixed square");
    assert.equal(done.turns, 6);
    const events = (await h.api("GET", `/api/runs/${run.id}/events`, undefined, cookie)).body as { type: string; data: any }[];
    const tests = events.find((e) => e.type === "tool_end" && e.data.name === "ws_bash");
    assert.match(tests?.data.output, /exit code 0/);
    assert.match(tests?.data.output, /pass 1/);
    assert.equal(events.filter((e) => e.type === "push").at(-1)?.data.status, "pushed");
    assert.ok(h.remoteBranches().includes(run.branch));
    const pushed = execFileSync("/usr/bin/git", ["show", `${run.branch}:math.js`], { cwd: h.remote }).toString();
    assert.match(pushed, /x \* x/);
    assert.equal(h.services.pool.list().every((w) => w.status === "free"), true);
  });

  test("cannot read outside its worktree", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([call("ws_read", { path: "../../../ws-2/secret.txt" }), call("ws_bash", { command: "cat ../../../ws-2/secret.txt" }), report("tried")]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Snoop", brief: "x" }, cookie)).body;
    await h.services.runs.settled(run.id);
    const ends = h.services.runs.events(run.id).filter((e) => e.type === "tool_end");
    assert.equal(ends[0]?.data.isError, true);
    assert.match(String(ends[0]?.data.output), /outside the allowed directory/);
    assert.match(String(ends[1]?.data.output), /Operation not permitted|No such file/);
    assert.doesNotMatch(String(ends[1]?.data.output), /ws-2 only/);
  });

  test("a commit with a secret is rejected and never reaches the remote", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([
      call("ws_write", { path: "config.js", content: 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' }),
      call("git_commit", { message: "Add config" }),
      call("git_push", {}),
      report("blocked"),
    ]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Leak", brief: "x" }, cookie)).body;
    await h.services.runs.settled(run.id);
    const push = h.services.relay.history(run.projectId)[0];
    assert.equal(push?.status, "rejected");
    assert.match(push?.reason ?? "", /AWS access key/);
    assert.ok(!h.remoteBranches().includes(run.branch));
    const pushEnd = h.services.runs.events(run.id).find((e) => e.type === "tool_end" && e.data.name === "git_push");
    assert.equal(pushEnd?.data.isError, true);
  });

  test("cancel stops a long command and frees the workstation", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([call("ws_bash", { command: "sleep 60" }), report()]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Slow", brief: "x" }, cookie)).body;
    await until(() => h.services.runs.events(run.id).some((e) => e.type === "tool_start"));
    const started = Date.now();
    await h.api("POST", `/api/runs/${run.id}/cancel`, {}, cookie);
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "cancelled");
    assert.ok(Date.now() - started < 5000);
    assert.equal(h.services.pool.list().every((w) => w.status === "free"), true);
  });

  test("the turn limit stops a run that never finishes", async () => {
    h = await harness({ limits: { maxTurns: 2, maxDurationMs: 60_000, maxCostUsd: 1 } });
    const { cookie, agentId } = await h.ready();
    h.script([call("git_status", {}), call("git_status", {}), call("git_status", {}), report()]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Loop", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /turn limit/);
  });

  test("a failed model request is retried", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 502" }), report("after retry")]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Flaky", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.report?.summary, "after retry");
    assert.ok(h.services.runs.events(run.id).some((e) => e.type === "error" && /upstream 502/.test(String(e.data.message))));
  });

  test("a follow-up continues the same session on the same workstation", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([fauxAssistantMessage(fauxText("First answer."))]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Chat", brief: "hello" }, cookie)).body;
    const first = await h.services.runs.settled(run.id);
    assert.equal(first.status, "succeeded");
    let roles: string[] = [];
    h.script([(context) => {
      roles = context.messages.map((m) => m.role);
      return fauxAssistantMessage(fauxText("Second answer."));
    }]);
    await h.api("POST", `/api/runs/${run.id}/messages`, { text: "and again" }, cookie);
    const second = await h.services.runs.settled(run.id);
    assert.equal(second.status, "succeeded");
    assert.equal(second.workstationId, first.workstationId);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    assert.equal(second.report?.summary, "Second answer.");
  });

  test("runs interrupted by a restart are marked and can be resumed", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([call("ws_bash", { command: "sleep 30" })]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Restart", brief: "x" }, cookie)).body;
    await until(() => h.services.runs.events(run.id).some((e) => e.type === "tool_start"));
    await h.services.runs.stopAll();
    h.db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
    h.services.runs.recover();
    const v = h.services.runs.view(run.id);
    assert.equal(v.status, "failed");
    assert.match(v.error ?? "", /restart/);
  });
});

describe("the Relay", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("rejects a secret that a later commit deletes, and workflow changes", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([
      call("ws_write", { path: "config.js", content: 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' }),
      call("git_commit", { message: "Add config" }),
      call("ws_write", { path: "config.js", content: "export const key = process.env.KEY;\n" }),
      call("git_commit", { message: "Read the key from the environment" }),
      call("git_push", {}),
      call("ws_bash", { command: "git reset --hard -q origin/main && mkdir -p .github/workflows && echo 'on: push' > .github/workflows/x.yml" }),
      call("git_commit", { message: "Add a workflow" }),
      call("git_push", {}),
      report("blocked twice"),
    ]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "History", brief: "x" }, cookie)).body;
    await h.services.runs.settled(run.id);
    const [workflow, history] = h.services.relay.history(run.projectId);
    assert.match(history?.reason ?? "", /AWS access key/);
    assert.match(workflow?.reason ?? "", /\.github\//);
    assert.ok(!h.remoteBranches().includes(run.branch));
  });
});
