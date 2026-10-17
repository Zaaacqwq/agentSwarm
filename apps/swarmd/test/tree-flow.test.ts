import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness, type Harness } from "./harness.ts";
import { TreeError } from "../src/agents/tree-service.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary: string) => call("report", { summary, tests: "node --test: ok", unfinished: [] });

/** Child ids by name, read from earlier spawn_agent results in the transcript. */
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

const writeModule = (file: string, body: string) => call("ws_write", { path: file, content: body });

describe("an agent tree", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("a lead splits work, waits without holding a workstation, reviews, merges and opens one PR", async () => {
    // One run at a time: the children can only run because the waiting lead gives its slot up.
    h = await harness({ maxConcurrentRuns: 1 });
    const { cookie, agentId } = await h.ready();
    let resumedWith = "";
    const script = h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "Sum", role: "developer", brief: "Add sum.js exporting sum(xs) that adds numbers, with a test." }),
        call("spawn_agent", { name: "Range", role: "developer", brief: "Add range.js exporting range(n) returning 0..n-1, with a test." }),
        call("wait_agents", {}),
        (context) => {
          resumedWith = lastText(context);
          return call("review_agent", { id: ids(context).Sum! });
        },
        callWith("review_agent", (i) => ({ id: i.Range! })),
        callWith("merge_agent", (i) => ({ id: i.Sum! })),
        callWith("merge_agent", (i) => ({ id: i.Range! })),
        call("ws_bash", { command: "node --test" }),
        call("git_push", {}),
        call("open_pull_request", { title: "Add sum and range", body: "Two helpers." }),
        report("sum and range merged"),
      ],
      Sum: [
        writeModule("sum.js", "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n"),
        writeModule("sum.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("sum", () => assert.equal(sum([1, 2, 3]), 6));\n'),
        call("git_commit", { message: "Add sum" }),
        call("git_push", {}),
        report("added sum"),
      ],
      Range: [
        writeModule("range.js", "export const range = (n) => Array.from({ length: n }, (_, i) => i);\n"),
        call("git_commit", { message: "Add range" }),
        call("git_push", {}),
        report("added range"),
      ],
      "Sum-review": [call("ws_bash", { command: "node --test sum.test.js" }), call("review_verdict", { approved: true, comments: "Looks right; test passes." })],
      "Range-review": [call("review_verdict", { approved: true, comments: "Fine." })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Helpers", brief: "Add sum and range." }, cookie)).body;
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", `${done.error} / left: ${script.remaining()}`);
    assert.deepEqual(script.remaining(), []);
    assert.match(resumedWith, /Your sub-agents reported back/);
    assert.match(resumedWith, /Sum \(run_[0-9a-f]+\) — succeeded/);

    const tree = (await h.api("GET", `/api/trees/${root.treeId}`, undefined, cookie)).body;
    const byName = Object.fromEntries(tree.nodes.map((n: any) => [n.agentName, n]));
    assert.equal(tree.nodes.length, 5);
    assert.match(byName.Sum.branch, new RegExp(`^swarm/demo/${root.treeId}/sum$`));
    assert.equal(byName.Sum.parentRunId, root.id);
    assert.equal(byName.Sum.review.approved, true);
    assert.ok(byName.Sum.mergedAt && byName.Range.mergedAt);
    assert.equal(byName["Sum-review"].kind, "review");
    assert.equal(h.pullRequests.length, 1);
    assert.equal(h.pullRequests[0]!.head, root.branch);
    assert.equal(h.pullRequests[0]!.base, "main");
    assert.equal(done.prUrl, "https://github.com/tester/demo/pull/1");
    const files = execFileSync("/usr/bin/git", ["ls-tree", "--name-only", root.branch], { cwd: h.remote }).toString();
    assert.match(files, /sum\.js/);
    assert.match(files, /range\.js/);
    assert.ok(h.services.pool.list().every((w) => w.status === "free"));
  });

  test("a grandchild branches from its parent's pushed work and merges back up", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "Strings", role: "developer", brief: "Add capitalize.js; delegate titleCase.js to a sub-agent." }),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.Strings! })),
        callWith("merge_agent", (i) => ({ id: i.Strings! })),
        call("git_push", {}),
        report("strings merged"),
      ],
      Strings: [
        writeModule("capitalize.js", "export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);\n"),
        call("git_commit", { message: "Add capitalize" }),
        call("git_push", {}),
        call("spawn_agent", { name: "Title", role: "developer", brief: "Add titleCase.js using capitalize.js from this branch." }),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.Title! })),
        callWith("merge_agent", (i) => ({ id: i.Title! })),
        call("git_push", {}),
        report("capitalize and titleCase"),
      ],
      Title: [
        call("ws_bash", { command: "test -f capitalize.js && echo has-capitalize" }),
        writeModule("title.js", 'import { capitalize } from "./capitalize.js";\nexport const titleCase = (s) => s.split(" ").map(capitalize).join(" ");\n'),
        call("git_commit", { message: "Add titleCase" }),
        call("git_push", {}),
        report("added titleCase"),
      ],
      "Title-review": [call("review_verdict", { approved: true, comments: "ok" })],
      "Strings-review": [call("review_verdict", { approved: true, comments: "ok" })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Strings", brief: "String helpers." }, cookie)).body;
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    const nodes = h.services.runs.tree(root.treeId).nodes;
    const title = nodes.find((n) => n.agentName === "Title")!;
    const strings = nodes.find((n) => n.agentName === "Strings")!;
    assert.equal(title.depth, 2);
    assert.match(title.branch, new RegExp(`/${root.treeId}/strings--title$`));
    assert.equal(title.baseBranch, strings.branch);
    const has = h.services.runs.events(title.id).find((e) => e.type === "tool_end" && e.data.name === "ws_bash");
    assert.match(String(has?.data.output), /has-capitalize/);
    const files = execFileSync("/usr/bin/git", ["ls-tree", "--name-only", root.branch], { cwd: h.remote }).toString();
    assert.match(files, /capitalize\.js/);
    assert.match(files, /title\.js/);
  });

  test("conflicts and rejected reviews come back to the parent, and nothing half-merged is left", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let mergeOutput = "";
    let reviewOutput = "";
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "A", role: "developer", brief: "Rewrite README.md to say A, and commit." }),
        call("spawn_agent", { name: "B", role: "developer", brief: "Rewrite README.md to say B, and commit." }),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.A! })),
        callWith("review_agent", (i) => ({ id: i.B! })),
        (context) => {
          reviewOutput = lastText(context);
          return call("merge_agent", { id: ids(context).A! });
        },
        callWith("merge_agent", (i) => ({ id: i.B! })),
        (context) => {
          mergeOutput = lastText(context);
          return report("A merged; B needs work");
        },
      ],
      A: [writeModule("README.md", "A\n"), call("git_commit", { message: "A" }), call("git_push", {}), report("A")],
      B: [writeModule("README.md", "B\n"), call("git_commit", { message: "B" }), call("git_push", {}), report("B")],
      "A-review": [call("review_verdict", { approved: true, comments: "ok" })],
      "B-review": [call("review_verdict", { approved: false, comments: "Say why B." })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Readme", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.match(reviewOutput, /CHANGES REQUESTED/);
    assert.match(reviewOutput, /Say why B/);
    assert.match(mergeOutput, /not been approved/);
    const nodes = h.services.runs.tree(root.treeId).nodes;
    assert.ok(nodes.find((n) => n.agentName === "A")!.mergedAt);
    assert.equal(nodes.find((n) => n.agentName === "B")!.mergedAt, null);
  });

  test("a merge conflict is reported with its files and leaves the worktree clean", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let conflict = "";
    let status = "";
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "A", role: "developer", brief: "Rewrite README.md to say A, and commit." }),
        call("spawn_agent", { name: "B", role: "developer", brief: "Rewrite README.md to say B, and commit." }),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.A! })),
        callWith("review_agent", (i) => ({ id: i.B! })),
        callWith("merge_agent", (i) => ({ id: i.A! })),
        callWith("merge_agent", (i) => ({ id: i.B! })),
        (context) => {
          conflict = lastText(context);
          return call("git_status", {});
        },
        (context) => {
          status = lastText(context);
          return report("A merged; B conflicts");
        },
      ],
      A: [writeModule("README.md", "A\n"), call("git_commit", { message: "A" }), call("git_push", {}), report("A")],
      B: [writeModule("README.md", "B\n"), call("git_commit", { message: "B" }), call("git_push", {}), report("B")],
      "A-review": [call("review_verdict", { approved: true, comments: "ok" })],
      "B-review": [call("review_verdict", { approved: true, comments: "ok" })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Readme", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.match(conflict, /conflicts in: README\.md/);
    assert.doesNotMatch(status, /UU README/);
  });

  test("cancelling the root cancels the whole tree and frees every workstation", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.scriptAgents({
      Dev: [call("spawn_agent", { name: "Slow", role: "developer", brief: "Run a very long command for this test." }), call("wait_agents", {})],
      Slow: [call("ws_bash", { command: "sleep 60" })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Cancel me", brief: "x" }, cookie)).body;
    const until = async (check: () => boolean) => {
      const end = Date.now() + 15_000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => h.services.runs.tree(root.treeId).nodes.some((n) => n.agentName === "Slow" && n.status === "running") && h.services.runs.view(root.id).status === "waiting");
    await until(() => h.services.runs.events(h.services.runs.tree(root.treeId).nodes.find((n) => n.agentName === "Slow")!.id).some((e) => e.type === "tool_start"));
    assert.equal((await h.api("POST", `/api/runs/${root.id}/cancel`, {}, cookie)).status, 200);
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "cancelled");
    const slow = h.services.runs.tree(root.treeId).nodes.find((n) => n.agentName === "Slow")!;
    assert.equal((await h.services.runs.settled(slow.id)).status, "cancelled");
    assert.ok(h.services.pool.list().every((w) => w.status === "free"));
  });

  test("depth, tree size and budget are enforced", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.scriptAgents({ Dev: [report("nothing")] });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Limits", brief: "x", budgetUsd: 1 }, cookie)).body;
    await h.services.runs.settled(root.id);
    const tree = h.services.tree;
    // Only a running parent may spawn; act as if the root were still working.
    const running = (id: string) => h.db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id);
    running(root.id);
    const rootRow = tree.run(root.id);
    await assert.rejects(tree.spawn(rootRow, { name: "Big", role: "dev", brief: "x".repeat(30), budgetUsd: 5 }), (e: Error) => e instanceof TreeError && /Not enough budget/.test(e.message));
    const half = await tree.spawn(rootRow, { name: "Half", role: "dev", brief: "x".repeat(30) });
    // Default share: 30% of what the root can give away ($1 minus its $0.15 reserve).
    assert.equal(half.budgetUsd, 0.255);
    assert.equal(tree.ownCap(tree.run(root.id)), 0.745);
    running(half.id);
    let deep = half;
    // Each level keeps $0.05 for itself, so the middle level needs room for the one below it.
    deep = await tree.spawn(deep, { name: "D2", role: "dev", brief: "x".repeat(30), budgetUsd: 0.15 });
    running(deep.id);
    deep = await tree.spawn(deep, { name: "D3", role: "dev", brief: "x".repeat(30), budgetUsd: 0.05 });
    running(deep.id);
    assert.equal(deep.depth, 3);
    await assert.rejects(tree.spawn(deep, { name: "Too deep", role: "dev", brief: "x".repeat(30), budgetUsd: 0.01 }), /Depth limit/);
    h.services.runs.cancel("test", root.id);
  });

  test("parallel spawns cannot overspend the budget or share a branch", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.scriptAgents({ Dev: [report("nothing")] });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Race", brief: "x", budgetUsd: 1 }, cookie)).body;
    await h.services.runs.settled(root.id);
    h.db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(root.id);
    const row = h.services.tree.run(root.id);
    const greedy = await Promise.allSettled([1, 2, 3].map(() => h.services.tree.spawn(row, { name: "Same", role: "dev", brief: "x".repeat(30), budgetUsd: 0.8 })));
    assert.equal(greedy.filter((r) => r.status === "fulfilled").length, 1);
    const fair = await Promise.all([1, 2].map(() => h.services.tree.spawn(h.services.tree.run(root.id), { name: "Same", role: "dev", brief: "x".repeat(30), budgetUsd: 0.01 })));
    const branches = h.services.runs.tree(root.treeId).nodes.map((n) => n.branch);
    assert.equal(new Set(branches).size, branches.length);
    assert.ok(fair.every((c) => c.budgetUsd === 0.01));
    h.services.runs.cancel("test", root.id);
  });

  test("an approval is void once the child is asked for more work", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let mergeOutput = "";
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "A", role: "developer", brief: "Add a.js, commit and push." }),
        call("wait_agents", {}),
        callWith("review_agent", (i) => ({ id: i.A! })),
        callWith("message_agent", (i) => ({ id: i.A!, text: "Also add b.js." })),
        call("wait_agents", {}),
        callWith("merge_agent", (i) => ({ id: i.A! })),
        (context) => {
          mergeOutput = lastText(context);
          return report("not merged");
        },
      ],
      A: [
        writeModule("a.js", "export const a = 1;\n"), call("git_commit", { message: "a" }), call("git_push", {}), report("a"),
        writeModule("b.js", "export const b = 2;\n"), call("git_commit", { message: "b" }), call("git_push", {}), report("a and b"),
      ],
      "A-review": [call("review_verdict", { approved: true, comments: "ok" })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Void", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.match(mergeOutput, /not been approved/);
    assert.equal(h.services.runs.tree(root.treeId).nodes.find((n) => n.agentName === "A")!.mergedAt, null);
  });

  test("cancelling a child wakes its waiting parent, and a parent cannot finish before its children", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let woke = "";
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "Slow", role: "developer", brief: "Run a very long command for this test." }),
        report("reported too early"),
        (context) => {
          woke = lastText(context);
          return report("done after the child");
        },
      ],
      Slow: [call("ws_bash", { command: "sleep 60" })],
    });
    const root = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Early", brief: "x" }, cookie)).body;
    const until = async (check: () => boolean) => {
      const end = Date.now() + 15_000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => h.services.runs.view(root.id).status === "waiting");
    const slow = h.services.runs.tree(root.treeId).nodes.find((n) => n.agentName === "Slow")!;
    await until(() => h.services.runs.events(slow.id).some((e) => e.type === "tool_start"));
    assert.equal((await h.api("POST", `/api/runs/${slow.id}/cancel`, {}, cookie)).status, 200);
    const done = await h.services.runs.settled(root.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.report?.summary, "done after the child");
    assert.match(woke, /Slow \(run_[0-9a-f]+\) — cancelled/);
  });
});
