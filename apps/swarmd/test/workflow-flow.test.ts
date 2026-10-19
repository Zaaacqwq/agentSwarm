import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TicketDiffView, TicketView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";
import { parseDiff, QUICK_KEEP_MS } from "../src/tickets/ticket-service.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const docsOf = (c: TranscriptContext) => /in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const commitPush = (message: string) => [call("git_commit", { message }), call("git_push", {})];
const lastText = (c: TranscriptContext) => JSON.stringify(c.messages.at(-1) ?? "");
const idOf = (c: TranscriptContext, name: string) => new RegExp(`Spawned ${name}: id (run_[0-9a-f]+)`).exec(JSON.stringify(c.messages))?.[1] ?? "missing";
const seen = (into: string[], next: FauxResponseFactory | ReturnType<typeof call>): FauxResponseFactory => (c, o, s, m) => {
  into.push(lastText(c));
  return typeof next === "function" ? next(c, o, s, m) : next;
};

async function ticket(h: Harness, key: string, cond: (t: TicketView) => boolean, what: string): Promise<TicketView> {
  await until(() => cond(h.services.tickets.view(key)), 30_000).catch(() => {
    const t = h.services.tickets.view(key);
    const msgs = t.missionId ? h.services.missions.messages(t.missionId).slice(-4).map((x) => `${x.author}/${x.kind}: ${x.text.slice(0, 300)}`).join(" | ") : "";
    throw new Error(`${key} is ${t.status} (stage ${t.stage}, need ${t.need}), wanted ${what}; last messages: ${msgs}`);
  });
  return h.services.tickets.view(key);
}

describe("R10: reading a change", () => {
  test("numstat and the unified diff become files with their hunks, renames included", () => {
    const numstat = "3\t1\tsrc/a.ts\n-\t-\tdocs/shot.jpg\n2\t0\tsrc/{old => new}/b.ts\n";
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,4 @@", " x", "-y", "+y2", "+z", "+w",
      "diff --git a/docs/shot.jpg b/docs/shot.jpg", "new file mode 100644", "Binary files /dev/null and b/docs/shot.jpg differ",
      "diff --git a/src/old/b.ts b/src/new/b.ts", "similarity index 90%", "rename from src/old/b.ts", "rename to src/new/b.ts", "--- a/src/old/b.ts", "+++ b/src/new/b.ts", "@@ -1 +1,3 @@", " a", "+b", "+c",
    ].join("\n");
    const { files, truncated } = parseDiff(numstat, patch);
    assert.equal(truncated, false);
    assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]), [
      ["src/a.ts", "modified", 3, 1, false], ["docs/shot.jpg", "added", 0, 0, true], ["src/new/b.ts", "renamed", 2, 0, false],
    ]);
    assert.equal(files[2]!.oldPath, "src/old/b.ts");
    assert.match(files[0]!.patch, /^@@ -1,2 \+1,4 @@\n x\n-y\n\+y2/);
  });
});

describe("R10: the three kinds of ticket", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("a change: built, checked, proposed; sent back with comments; merged from the dashboard; a retrospective only because something went wrong", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    await h.api("PUT", `/api/projects/${projectId}/profile`, { profile: { test: "test -f fixed.txt" } }, cookie);
    const saw: string[] = [];
    h.scriptAgents({
      Dev: [
        call("ws_write", { path: "math.js", content: "export const square = (x) => x * x;\n" }),
        ...commitPush("Fix square"),
        call("open_pull_request", { title: "Fix square", body: "square multiplies." }),
        call("stage_done", { summary: "square multiplies now." }),
        seen(saw, call("ws_write", { path: "fixed.txt", content: "yes\n" })),
        ...commitPush("Make the check pass"),
        // It stops without finishing: it is told to go on.
        fauxAssistantMessage(fauxText("Done, I think.")),
        seen(saw, call("stage_done", { summary: "square multiplies; the check passes." })),
        // Sent back.
        seen(saw, call("ws_write", { path: "math.js", content: "/** Squares a number. */\nexport const square = (x) => x * x;\n" })),
        ...commitPush("Comment square"),
        call("stage_done", { summary: "Commented." }),
        // The retrospective (something went wrong on the way).
        seen(saw, call("stage_done", { summary: "Checks failed once: run them before stage_done." })),
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "project", projectId, kind: "change", title: "square adds", description: "square(3) must be 9.", status: "todo" }, cookie)).body as TicketView;
    const review = await ticket(h, t.key, (x) => x.status === "review", "in review");
    assert.deepEqual([review.stage, review.need], ["awaiting_merge", "merge"]);
    assert.match(saw[0]!, /The project's checks failed \(test -f fixed\.txt/);
    assert.match(saw[1]!, /You stopped without finishing the building stage/);
    assert.equal(h.services.missions.view(review.missionId!).stage, "awaiting_merge");
    // You read the change file by file.
    const diff = (await h.api("GET", `/api/tickets/${t.key}/diff`, undefined, cookie)).body as TicketDiffView;
    assert.ok(diff.files.some((f) => f.path === "math.js" && /\+export const square = \(x\) => x \* x;/.test(f.patch)), JSON.stringify(diff.files.map((f) => f.path)));
    // You comment on a line and send it back.
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/send-back`, { comments: [{ path: "math.js", line: 1, text: "Add a doc comment." }] }, cookie)).status, 200);
    await ticket(h, t.key, (x) => x.status === "review" && x.stage === "awaiting_merge" && saw.length >= 3, "back in review");
    assert.match(saw[2]!, /sent it back with these comments[\s\S]*1\. math\.js:1: Add a doc comment\./);
    // You merge it here; something went wrong on the way, so there is a short retrospective.
    const merged = await h.api("POST", `/api/tickets/${t.key}/merge`, {}, cookie);
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(h.prStates.get(1), "merged");
    const done = await ticket(h, t.key, (x) => x.status === "done", "done");
    assert.match(saw[3]!, /merged the pull request/);
    assert.equal(done.stage, "done");
  });

  test("a change with a plan first; QA's screenshots merge without a review, code does not; a smooth change ends at the merge", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    const merges: string[] = [];
    h.scriptAgents({
      Dev: [
        writeDoc("plan.md", "# Plan\nFix square in math.js.\n"), ...commitPush("Plan"),
        call("request_approval", { summary: "Fix square in math.js." }),
        // Building, after your approval.
        call("ws_write", { path: "math.js", content: "export const square = (x) => x * x;\n" }), ...commitPush("Fix square"),
        call("spawn_agent", { name: "qa", role: "qa", brief: "Take one screenshot of the result and push it as evidence." }),
        call("spawn_agent", { name: "dev", role: "developer", brief: "Add a cube function in cube.js and push it." }),
        call("wait_agents", {}),
        (c) => call("merge_agent", { id: idOf(c, "qa") }),
        seen(merges, (c) => call("merge_agent", { id: idOf(c, "dev") })),
        seen(merges, call("open_pull_request", { title: "Fix square", body: "Fixed, with a screenshot." })),
        call("stage_done", { summary: "Fixed." }),
      ],
      qa: [(c) => call("ws_write", { path: `${docsOf(c) === "docs/missing" ? "docs/agentswarm/shots" : docsOf(c)}/screenshots/01-result.jpg`, content: "jpeg" }), ...commitPush("Screenshot"), call("report", { summary: "One screenshot.", tests: "-", unfinished: [] })],
      dev: [call("ws_write", { path: "cube.js", content: "export const cube = (x) => x * x * x;\n" }), ...commitPush("Cube"), call("report", { summary: "Cube.", tests: "-", unfinished: [] })],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "project", projectId, kind: "change", title: "square adds", description: "square(3) must be 9.", status: "todo", options: { planFirst: true } }, cookie)).body as TicketView;
    const plan = await ticket(h, t.key, (x) => x.need === "approve", "a plan for you");
    assert.equal(plan.status, "needs_you");
    assert.equal((await h.api("POST", `/api/missions/${plan.missionId}/approve`, {}, cookie)).status, 200);
    await ticket(h, t.key, (x) => x.status === "review", "in review");
    assert.match(merges[0]!, /Merged swarm\/.*qa/, "screenshots only: no review needed");
    assert.match(merges[1]!, /has not been approved by a review/, "code still needs a review");
    await h.api("POST", `/api/tickets/${t.key}/merge`, {}, cookie);
    const done = await ticket(h, t.key, (x) => x.status === "done", "done at once");
    const m = h.services.missions.view(done.missionId!);
    assert.equal(m.stage, "done");
    assert.match(m.retro ?? "", /Cost|cost|\$/, "the facts are kept without a retrospective");
  });

  test("retry: the attempt stops, its pull request closes, and a new one starts with Claude Code and your note", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    let second = "";
    h.scriptAgents({
      Dev: [
        call("ws_write", { path: "math.js", content: "export const square = (x) => x + x + 0;\n" }), ...commitPush("Try"),
        call("open_pull_request", { title: "Fix square", body: "Hm." }),
        call("stage_done", { summary: "Tried." }),
        (c) => {
          second = JSON.stringify(c.messages);
          return call("ask_user", { question: "Starting over: anything else?" });
        },
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "project", projectId, kind: "change", title: "square adds", description: "square(3) must be 9.", status: "todo" }, cookie)).body as TicketView;
    const first = await ticket(h, t.key, (x) => x.status === "review", "in review");
    const retried = await h.api("POST", `/api/tickets/${t.key}/retry`, { worker: "claude_code", note: "Keep it simple." }, cookie);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(h.prStates.get(1), "closed", "the earlier pull request is closed");
    const again = await ticket(h, t.key, (x) => x.need === "answer", "the new lead asks");
    assert.notEqual(again.missionId, first.missionId);
    assert.deepEqual(again.attempts.map((a) => [a.missionId, a.worker, a.note]), [[first.missionId, "claude_code", "Keep it simple."]]);
    assert.equal(h.services.missions.view(first.missionId!).stage, "cancelled");
    assert.match(second, /new attempt[\s\S]*Claude Code sub-agent[\s\S]*Keep it simple\./);
  });

  test("a new project: a plan you approve, built locally, then kept: a GitHub repository and a project with its settings", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    h.scriptAgents({
      Lead: [
        writeDoc("plan.md", "# Plan\nA CSV to Markdown page.\n"), ...commitPush("Plan"),
        call("request_approval", { summary: "A CSV to Markdown page." }),
        call("ws_write", { path: "index.html", content: "<h1>CSV</h1>\n" }),
        call("suggest_profile", { platform: "web", test: "true" }),
        writeDoc("results.md", "# Results\nindex.html turns CSV into Markdown.\n"), ...commitPush("Build"),
        call("stage_done", { summary: "Built: index.html." }),
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "sandbox", kind: "newproject", title: "CSV to Markdown", description: "A page that turns CSV into a Markdown table.", status: "todo" }, cookie)).body as TicketView;
    assert.equal(t.key, "NEW-1");
    const plan = await ticket(h, t.key, (x) => x.need === "approve", "a plan for you");
    await h.api("POST", `/api/missions/${plan.missionId}/approve`, {}, cookie);
    const ready = await ticket(h, t.key, (x) => x.status === "review", "ready for you");
    assert.equal(ready.need, "decide");
    const localId = ready.projectId!;
    const kept = await h.api("POST", `/api/tickets/${t.key}/keep`, {}, cookie);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const done = await ticket(h, t.key, (x) => x.status === "done", "done");
    const project = h.services.projects.list().find((p) => p.githubRepo.startsWith("tester/csv-to-markdown"))!;
    assert.ok(project, JSON.stringify(h.services.projects.list().map((p) => p.githubRepo)));
    assert.deepEqual([project.profile?.platform, project.profile?.test], ["web", "true"], "it starts with the settings its lead suggested");
    assert.match(execFileSync("/usr/bin/git", ["ls-tree", "-r", "--name-only", "main"], { cwd: h.services.projects.get(project.id).mirrorPath }).toString(), /index\.html/);
    assert.ok(!h.services.projects.list().some((p) => p.id === localId), "the local repository is archived");
    assert.ok(h.services.tickets.events(done.key).some((e) => e.kind === "kept"));
  });

  test("quick tests: a result to read; finished results are cleaned up after a week; a dropped one at once", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    h.scriptAgents({
      Lead: [
        writeDoc("results.md", "# Results\nIt works.\n"), ...commitPush("Try"),
        call("stage_done", { summary: "It works." }),
        writeDoc("results.md", "# Results\nNo.\n"), ...commitPush("Try"),
        call("stage_done", { summary: "It does not." }),
      ],
    });
    const make = async (title: string) => (await h.api("POST", "/api/tickets", { space: "sandbox", kind: "quick", title, description: "Does it work?", status: "todo" }, cookie)).body as TicketView;
    const a = await make("Try A");
    const ra = await ticket(h, a.key, (x) => x.status === "review", "a result for you");
    assert.equal(ra.need, "decide");
    assert.equal((await h.api("POST", `/api/tickets/${a.key}/finish`, {}, cookie)).status, 200);
    await ticket(h, a.key, (x) => x.status === "done", "done");
    assert.ok(h.services.projects.list().some((p) => p.id === ra.projectId), "kept for a week");
    await h.services.tickets.sweepQuick(Date.now() + QUICK_KEEP_MS + 60_000);
    assert.ok(!h.services.projects.list().some((p) => p.id === ra.projectId), "cleaned up after a week");
    assert.ok(h.services.tickets.events(a.key).some((e) => e.kind === "cleaned"));
    const b = await make("Try B");
    const rb = await ticket(h, b.key, (x) => x.status === "review", "a result for you");
    assert.equal((await h.api("POST", `/api/tickets/${b.key}/drop`, {}, cookie)).status, 200);
    await ticket(h, b.key, (x) => x.status === "canceled", "dropped");
    assert.ok(!h.services.projects.list().some((p) => p.id === rb.projectId));
  });
});
