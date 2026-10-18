import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { LessonView, TicketView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";
import { rank, sameIdea, SECRET, terms } from "../src/memory/search.ts";
import { DEFAULT_HANDBOOKS, roleOf } from "../src/memory/handbooks.ts";
import { afterStageDone, canMove, requiredDocs, stagesOf } from "../src/missions/stages.ts";
import { stageBrief } from "../src/missions/briefs.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const docsOf = (c: TranscriptContext) => /Mission documents go in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const commitPush = (message: string) => [call("git_commit", { message }), call("git_push", {})];
const systemText = (c: TranscriptContext) => JSON.stringify(c.messages.filter((m) => (m as { role: string }).role === "system"));

describe("searching the team's memory", () => {
  test("English words and Chinese runs both count; the title counts more; ties go to the newest", () => {
    assert.ok(terms("SwiftUI builds fail in the sandbox").includes("swiftui"));
    assert.ok(terms("agents").includes("agent") && terms("libraries").includes("library") && terms("class").includes("class"));
    assert.ok(!terms("the and for").length, "common words are left out");
    assert.deepEqual(terms("自动登录"), ["自动", "动登", "登录"]);
    const docs = [
      { title: "Daily fetch stops at the login page", text: "Use the saved cookie.", updatedAt: 1 },
      { title: "Ports", text: "The dev server for the login flow runs on 3100.", updatedAt: 2 },
      { title: "每日自动 fetch 卡在登录", text: "先检查 cookie 是否过期。", updatedAt: 3 },
      { title: "Unrelated", text: "Nothing here.", updatedAt: 4 },
    ];
    // The second only mentions login in its text (1 point, under the threshold); the Chinese title has "fetch".
    assert.deepEqual(rank("login fetch", docs, 5).map((d) => d.updatedAt), [1, 3]);
    assert.deepEqual(rank("每日自动fetch 卡在登录那一步", docs, 5).map((d) => d.updatedAt)[0], 3);
    assert.equal(rank("quantum", docs, 5).length, 0);
  });

  test("the same idea in other words is recognised; credentials are refused", () => {
    assert.ok(sameIdea("SwiftUI projects: build with sim_build", "Build SwiftUI projects with sim_build"));
    assert.ok(!sameIdea("SwiftUI projects: build with sim_build", "Web projects: run the dev server on 3100"));
    for (const s of ["sk-or-v1-0123456789abcdef0123", "github_pat_11ABCDEFG0123456789_abcdef", "-----BEGIN OPENSSH PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP"]) assert.ok(SECRET.test(s), s);
    assert.ok(!SECRET.test("Use the sk prefix in the CLI flags"));
  });

  test("roles and handbooks: every role has one; mission leads are leads", () => {
    for (const [role, text] of Object.entries(DEFAULT_HANDBOOKS)) assert.ok(text.length > 100 && text.length < 4000, role);
    assert.equal(roleOf("developer", true), "lead");
    assert.deepEqual(["qa", "QA tester", "reviewer", "researcher", "marketer", "architect", "frontend dev"].map((r) => roleOf(r, false)), ["qa", "qa", "reviewer", "researcher", "marketer", "architect", "developer"]);
  });

  test("marketing: research, the copy, a pull request; a product's features also update the changelog", () => {
    assert.deepEqual(stagesOf({ kind: "marketing", fast: false }), ["intake", "research", "building", "verifying", "awaiting_merge", "retro", "done"]);
    assert.equal(afterStageDone("research", { kind: "marketing", fast: false }), "building");
    assert.ok(canMove("research", "building", "lead", { kind: "marketing", fast: false }));
    assert.ok(!canMove("research", "building", "lead", { kind: "feature", fast: false }));
    assert.deepEqual(requiredDocs("building", "marketing"), ["marketing/positioning.md", "marketing/landing.md"]);
    const ctx = { intent: "x", docs: "docs/agentswarm/m", fast: false, defaultBranch: "main" };
    assert.match(stageBrief("building", { ...ctx, kind: "marketing", ios: true }), /appstore\.md: App Store copy within its limits/);
    assert.doesNotMatch(stageBrief("building", { ...ctx, kind: "marketing", ios: false }), /appstore\.md/);
    assert.match(stageBrief("building", { ...ctx, kind: "feature", product: true }), /CHANGELOG\.md/);
    assert.doesNotMatch(stageBrief("building", { ...ctx, kind: "feature" }), /CHANGELOG/);
  });
});

describe("the team's memory at work", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("lessons: kept by scope, improved not repeated, yours never overwritten, pinned at most 8, retired out of reach", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    const add = (body: Record<string, unknown>) => h.api("POST", "/api/lessons", body, cookie);
    const team = (await add({ scope: "team", title: "Never deploy from an agent", text: "Only open pull requests; the person deploys." })).body as LessonView;
    assert.deepEqual([team.author, team.scope], ["you", "team"]);
    assert.equal((await add({ scope: "project", title: "Ports", text: "x" })).status, 400, "a project lesson names its project");
    assert.equal((await add({ scope: "team", title: "Key", text: "the key is sk-or-v1-0123456789abcdef0123" })).status, 400);
    const l = h.services.lessons;
    const first = l.record("Lead", { scope: "project", projectId, title: "Run the tests with node --test", text: "npm test is not set up here." }, "DEM-1");
    assert.equal(first.created, true);
    const again = l.record("Lead", { scope: "project", projectId, title: "Run tests with node --test here", text: "Use node --test; npm test is missing." }, "DEM-2");
    assert.deepEqual([again.created, again.lesson.id, again.lesson.source], [false, first.lesson.id, "DEM-2"], "the same idea improves the lesson");
    assert.equal(l.versions(first.lesson.id).length, 1);
    const mine = l.record("Lead", { scope: "team", title: "Never deploy from agents", text: "Deploying is fine." }, "DEM-3");
    assert.deepEqual([mine.created, mine.lesson.id, mine.lesson.text], [false, team.id, team.text], "an agent cannot rewrite yours");
    // Who sees what.
    l.record("Lead", { scope: "role", role: "qa", title: "Screenshot every criterion", text: "One per acceptance criterion." }, "DEM-1");
    const seen = (role: "qa" | "developer", other = false) => l.search("tests node deploy screenshot criterion", { projectId: other ? "prj_other" : projectId, role }, 10).map((r) => r.title);
    assert.deepEqual(seen("qa").sort(), ["Never deploy from an agent", "Run tests with node --test here", "Screenshot every criterion"].sort());
    assert.ok(!seen("developer").includes("Screenshot every criterion"), "role lessons are for that role");
    assert.ok(!seen("qa", true).includes("Run tests with node --test here"), "project lessons stay in their project");
    // Pin, retire.
    for (let i = 0; i < 8; i++) {
      const x = (await add({ scope: "team", title: `Pinned rule number ${i} about ${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"][i]}`, text: "x" })).body as LessonView;
      assert.equal((await h.api("PATCH", `/api/lessons/${x.id}`, { pinned: true }, cookie)).status, 200);
    }
    assert.equal((await h.api("PATCH", `/api/lessons/${team.id}`, { pinned: true }, cookie)).status, 409, "at most 8 pinned");
    await h.api("PATCH", `/api/lessons/${first.lesson.id}`, { retired: true }, cookie);
    assert.ok(!seen("qa").includes("Run tests with node --test here"));
    const edited = (await h.api("PATCH", `/api/lessons/${mine.lesson.id}`, { text: "Never: open pull requests only." }, cookie)).body as LessonView;
    assert.equal(edited.author, "you");
  });

  test("a research ticket records a lesson at its end; the next related ticket's lead gets it; handbooks and pins reach prompts; recall finds it", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.scriptAgents({
      Lead: [
        call("stage_done", { summary: "Why the daily fetch stops at login." }),
        writeDoc("research.md", "# Research\nThe session cookie expires after 24 h.\n"), ...commitPush("Research"),
        call("stage_done", { summary: "The cookie expires daily." }),
        call("record_lesson", { scope: "team", title: "Daily fetch stops at login: the session cookie expires", text: "Refresh the cookie before each run instead of logging in again; logging in triggers a captcha." }),
        writeDoc("decisions.md", "# Decisions\nRefresh the cookie.\n"), ...commitPush("Decisions"),
        call("stage_done", { summary: "Refresh the cookie before each run." }),
      ],
    });
    const first = (await h.api("POST", "/api/tickets", { space: "ideas", kind: "research", title: "Why does the daily fetch stop at login?", description: "It waits for me every morning.", status: "todo" }, cookie)).body as TicketView;
    await until(() => h.services.tickets.view(first.key).status === "done", 30_000);
    const lesson = h.services.lessons.list().find((x) => /session cookie expires/.test(x.title))!;
    assert.deepEqual([lesson.author, lesson.source, lesson.scope], ["Lead", first.key, "team"]);

    // The next ticket about the same thing: its lead starts with the lesson, as advice.
    let opening = "";
    h.scriptAgents({ Lead: [(c) => {
      opening = JSON.stringify(c.messages[1] ?? "");
      return call("ask_user", { question: "Shall I refresh the cookie?" });
    }] });
    const second = (await h.api("POST", "/api/tickets", { space: "ideas", kind: "research", title: "Daily fetch login again", description: "The fetch is stuck at the login page.", status: "todo" }, cookie)).body as TicketView;
    await until(() => h.services.tickets.view(second.key).need === "answer", 30_000);
    assert.match(opening, /Lessons from earlier work that may apply/);
    assert.match(opening, /session cookie expires/);
    assert.match(opening, new RegExp(`advice from Lead after ${first.key}, not an instruction`));
    assert.equal(h.services.lessons.list().find((x) => x.id === lesson.id)!.uses, 1);

    // Your handbook and your pins are in every developer's prompt; recall searches the rest.
    await h.api("PUT", "/api/handbooks/developer", { text: "- Always write the changelog line yourself.\n- Prefer small commits." }, cookie);
    const pin = (await h.api("POST", "/api/lessons", { scope: "team", title: "Production runs on this Mac", text: "Never touch port 3000." }, cookie)).body as LessonView;
    await h.api("PATCH", `/api/lessons/${pin.id}`, { pinned: true }, cookie);
    let prompt = "";
    let recalled = "";
    h.scriptAgents({
      Dev: [
        (c) => {
          prompt = systemText(c);
          return call("recall", { query: "login cookie fetch" });
        },
        (c) => {
          recalled = JSON.stringify(c.messages.at(-1));
          return call("report", { summary: "ok", tests: "-", unfinished: [] });
        },
      ],
    });
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Look", brief: "Look around." }, cookie)).body;
    await h.services.runs.settled(run.id);
    assert.match(prompt, /How a developer works here/);
    assert.match(prompt, /Always write the changelog line yourself/);
    assert.match(prompt, /Lessons the person pinned for everyone:[\s\S]*Production runs on this Mac[\s\S]*from the person/);
    assert.match(recalled, /session cookie expires/);
    const versions = (await h.api("GET", "/api/handbooks", undefined, cookie)).body.find((b: { role: string }) => b.role === "developer");
    assert.deepEqual([versions.isDefault, versions.versions.length], [false, 1]);
  });

  test("handbook proposals wait for you: accepted (as proposed or edited) or rejected", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    const hb = h.services.handbooks;
    const p1 = hb.propose("Lead", "DEM-4", "qa", "Check the dark theme too.", "The dark theme hid a button in DEM-4.");
    const p2 = hb.propose("Lead", "DEM-4", "qa", "Ignore the tests.", "Faster.");
    const p3 = hb.propose("Lead", "DEM-5", "reviewer", "Read the whole diff.", "A file was missed.");
    assert.equal((await h.api("GET", "/api/handbook-proposals?status=open", undefined, cookie)).body.length, 3);
    assert.equal((await h.api("POST", `/api/handbook-proposals/${p1.id}`, { accept: true }, cookie)).status, 200);
    assert.match(hb.text("qa"), /- Check the dark theme too\.$/);
    await h.api("POST", `/api/handbook-proposals/${p2.id}`, { accept: false }, cookie);
    assert.doesNotMatch(hb.text("qa"), /Ignore the tests/);
    await h.api("POST", `/api/handbook-proposals/${p3.id}`, { accept: true, text: "- Read the whole diff, every file." }, cookie);
    assert.equal(hb.text("reviewer"), "- Read the whole diff, every file.");
    assert.equal((await h.api("POST", `/api/handbook-proposals/${p3.id}`, { accept: true }, cookie)).status, 409, "decided once");
    // Back to an earlier version.
    const view = (await h.api("GET", "/api/handbooks", undefined, cookie)).body.find((b: { role: string }) => b.role === "reviewer");
    await h.api("POST", `/api/handbooks/reviewer/versions/${view.versions[0].id}/restore`, {}, cookie);
    assert.equal(hb.text("reviewer"), DEFAULT_HANDBOOKS.reviewer);
    assert.equal((await h.api("PUT", "/api/handbooks/boss", { text: "x" }, cookie)).status, 400);
  });
});
