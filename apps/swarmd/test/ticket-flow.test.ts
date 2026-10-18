import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TicketView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";
import { png } from "../../../packages/ws-exec/test/fake-sim.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const docsOf = (c: TranscriptContext) => /Mission documents go in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const commitPush = (message: string) => [call("git_commit", { message }), call("git_push", {})];

async function ticket(h: Harness, key: string, cond: (t: TicketView) => boolean, what: string): Promise<TicketView> {
  await until(() => cond(h.services.tickets.view(key)), 30_000).catch(() => {
    const t = h.services.tickets.view(key);
    throw new Error(`${key} is ${t.status} (stage ${t.stage}, need ${t.need}), wanted ${what}`);
  });
  return h.services.tickets.view(key);
}

describe("the board", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("ids, places and kinds: project prefix, SBX and IDEA; what goes where is checked", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    const make = (body: Record<string, unknown>) => h.api("POST", "/api/tickets", { title: "Something", description: "", kind: "feature", ...body }, cookie);
    const a = await make({ space: "project", projectId });
    const b = await make({ space: "project", projectId, kind: "bug" });
    assert.deepEqual([a.status, a.body.key, b.body.key, a.body.status], [200, "DEM-1", "DEM-2", "backlog"]);
    assert.equal((await make({ space: "sandbox", kind: "experiment" })).body.key, "SBX-1");
    assert.equal((await make({ space: "ideas", kind: "research" })).body.key, "IDEA-1");
    assert.equal((await make({ space: "project", projectId, kind: "experiment" })).status, 400, "experiments run in the sandbox");
    assert.equal((await make({ space: "sandbox", kind: "feature" })).status, 400);
    assert.equal((await make({ space: "project" })).status, 400, "a project is needed");
    // A prefix of your own.
    const p = (await h.api("GET", "/api/projects", undefined, cookie)).body.find((x: { id: string }) => x.id === projectId);
    assert.equal(p.ticketPrefix, "DEM");
    assert.equal((await h.api("PUT", `/api/projects/${projectId}/profile`, { profile: {}, ticketPrefix: "SBX" }, cookie)).status, 409, "reserved");
    await h.api("PUT", `/api/projects/${projectId}/profile`, { profile: {}, ticketPrefix: "APP" }, cookie);
    assert.equal((await make({ space: "project", projectId })).body.key, "APP-1");
    // Edits before it starts, by key; a move to another place renumbers it.
    const edited = await h.api("PATCH", "/api/tickets/DEM-1", { title: "Renamed", priority: 2 }, cookie);
    assert.deepEqual([edited.body.title, edited.body.priority], ["Renamed", 2]);
    const moved = await h.api("PATCH", "/api/tickets/DEM-2", { space: "ideas", kind: "research" }, cookie);
    assert.equal(moved.body.key, "IDEA-2");
    assert.ok(h.services.tickets.events("IDEA-2").some((e) => e.kind === "edited" && e.data.was === "DEM-2"));
    assert.equal((await h.api("DELETE", "/api/tickets/IDEA-2", undefined, cookie)).status, 204);
    assert.equal((await h.api("GET", "/api/tickets/IDEA-2", undefined, cookie)).status, 404);
  });

  test("todo starts by priority within the limit; needs you, answered, canceled; the slot passes on", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    await h.api("PUT", "/api/tickets/settings", { maxActive: 1 }, cookie);
    let leadSaw = "";
    h.scriptAgents({
      Dev: [
        (c) => {
          leadSaw = JSON.stringify(c.messages[1] ?? "");
          return call("ask_user", { question: "Which page?" });
        },
        call("ask_user", { question: "Anything else?" }),
        call("ask_user", { question: "Urgent: which one?" }),
      ],
    });
    const make = (title: string, priority: number) => h.api("POST", "/api/tickets", { space: "project", projectId, title, description: `about ${title}`, kind: "feature", priority }, cookie);
    const first = (await make("First one", 0)).body as TicketView;
    const low = (await make("Low one", 4)).body as TicketView;
    const urgent = (await make("Urgent one", 1)).body as TicketView;
    await h.api("POST", `/api/tickets/${first.key}/move`, { status: "todo" }, cookie);
    const running = await ticket(h, first.key, (t) => t.need === "answer", "waiting for an answer");
    assert.equal(running.status, "needs_you");
    assert.match(leadSaw, /First one/);
    assert.match(leadSaw, /about First one/);
    assert.match(leadSaw, /Ticket DEM-1/);
    assert.equal(h.services.missions.view(running.missionId!).origin, "ticket");
    // The slot is taken: both wait, the urgent one first although you put it last.
    await h.api("POST", `/api/tickets/${low.key}/move`, { status: "todo" }, cookie);
    await h.api("POST", `/api/tickets/${urgent.key}/move`, { status: "todo", after: low.id }, cookie);
    assert.deepEqual([h.services.tickets.view(urgent.key).queuePosition, h.services.tickets.view(low.key).queuePosition], [0, 1]);
    // Started: no more edits or moves except canceling.
    assert.equal((await h.api("PATCH", `/api/tickets/${first.key}`, { title: "x" }, cookie)).status, 409);
    assert.equal((await h.api("POST", `/api/tickets/${first.key}/move`, { status: "backlog" }, cookie)).status, 409);
    // Your answer through the mission: it works again, then asks again.
    await h.api("POST", `/api/missions/${running.missionId}/messages`, { text: "The home page." }, cookie);
    await ticket(h, first.key, (t) => t.need === "answer" && h.services.missions.messages(t.missionId!).some((m) => m.text === "Anything else?"), "asking again");
    // Canceled: the mission stops, the ticket is canceled, and the urgent one starts.
    const canceled = await h.api("POST", `/api/tickets/${first.key}/move`, { status: "canceled" }, cookie);
    assert.equal(canceled.status, 200);
    await ticket(h, first.key, (t) => t.status === "canceled", "canceled");
    assert.equal(h.services.missions.view(running.missionId!).stage, "cancelled");
    await ticket(h, urgent.key, (t) => t.status === "needs_you", "started after the slot freed");
    assert.equal(h.services.tickets.view(low.key).status, "todo");
    const record = h.services.tickets.events(first.key).map((e) => e.kind);
    assert.deepEqual(record.filter((k) => k !== "status"), ["created", "started", "ended"]);
  });

  test("pictures: checked, converted, shown to the lead and committed; fixed once it starts", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    const t = (await h.api("POST", "/api/tickets", { space: "project", projectId, title: "The button is cut off", description: "See the picture.", kind: "bug" }, cookie)).body as TicketView;
    const upload = (body: Buffer, type = "image/png") => h.app.inject({ method: "POST", url: `/api/tickets/${t.key}/attachments?name=${encodeURIComponent("screen shot.png")}`, payload: body, headers: { cookie, "content-type": type } });
    assert.equal((await upload(Buffer.from("<svg onload=alert(1)>"), "image/png")).statusCode, 400, "the bytes decide, not the type");
    const ok = await upload(png(300, 600));
    assert.equal(ok.statusCode, 200, ok.body);
    const pic = (JSON.parse(ok.body) as TicketView).attachments[0]!;
    assert.deepEqual([pic.name, pic.width, pic.height], ["screen shot.png", 300, 600]);
    const got = await h.app.inject({ method: "GET", url: pic.url, headers: { cookie } });
    assert.deepEqual([got.statusCode, got.headers["content-type"], got.rawPayload[0]], [200, "image/jpeg", 0xff]);
    assert.equal((await h.app.inject({ method: "GET", url: pic.url })).statusCode, 401);

    let images = 0;
    let listed = "";
    h.scriptAgents({
      Dev: [
        (c) => {
          images = JSON.stringify(c.messages).split('"type":"image"').length - 1;
          return call("ws_bash", { command: `ls ${docsOf(c)}/request && git status --short` });
        },
        (c) => {
          listed = JSON.stringify(c.messages.at(-1));
          return call("ask_user", { question: "Is this the button?" });
        },
      ],
    });
    await h.api("POST", `/api/tickets/${t.key}/move`, { status: "todo" }, cookie);
    await ticket(h, t.key, (x) => x.need === "answer", "asking");
    assert.equal(images, 1, "the lead saw the picture");
    assert.match(listed, /01-screen-shot\.jpg/, "in the worktree, with the mission's documents");
    assert.match(listed, /\?\? docs\//, "not ignored: it goes in with the documents' commit");
    assert.equal((await upload(png(10, 10))).statusCode, 409, "no new pictures once it started");
  });

  test("a lead files a follow-up: it waits in the backlog, from this ticket, even with free slots", async () => {
    h = await harness();
    const { cookie, projectId } = await h.ready();
    let filed = "";
    h.scriptAgents({
      Dev: [
        call("file_ticket", { title: "Login page has no tests", description: "Noticed while fixing the header: no test covers login.", kind: "bug" }),
        (c) => {
          filed = JSON.stringify(c.messages.at(-1));
          return call("ask_user", { question: "Done looking?" });
        },
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "project", projectId, title: "Header", description: "Fix the header", kind: "feature", status: "todo" }, cookie)).body as TicketView;
    await ticket(h, t.key, (x) => x.need === "answer", "asking");
    assert.match(filed, /Filed DEM-2 in the backlog/);
    const follow = h.services.tickets.view("DEM-2");
    assert.deepEqual([follow.status, follow.createdBy, follow.fromTicket, follow.kind, follow.missionId], ["backlog", "Dev", t.key, "bug", null]);
  });

  test("立项: a finished sandbox experiment becomes a repository, a project and a feature ticket in todo", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    h.scriptAgents({
      Lead: [
        call("stage_done", { summary: "Try a faster square." }),
        call("ws_write", { path: "bench.js", content: "console.log('ok');\n" }),
        writeDoc("results.md", "# Results\nThe fast square is 2x faster.\n"), ...commitPush("Experiment"),
        call("stage_done", { summary: "It works: 2x faster." }),
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "sandbox", title: "Faster square", description: "Is it faster?", kind: "experiment", status: "todo" }, cookie)).body as TicketView;
    const done = await ticket(h, t.key, (x) => x.status === "done", "done");
    assert.equal(h.services.projects.view(done.projectId!).kind, "local");
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/promote`, { repo: "not a repo" }, cookie)).status, 400);
    h.scriptAgents({ Lead: [call("ask_user", { question: "Plan it?" })] });
    const next = await h.api("POST", `/api/tickets/${t.key}/promote`, {}, cookie);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const real = h.services.projects.view(next.body.projectId);
    assert.equal(real.kind, "github");
    assert.match(real.githubRepo, /^tester\/faster-square/);
    assert.equal(next.body.fromTicket, t.key);
    const files = execFileSync("/usr/bin/git", ["ls-tree", "-r", "--name-only", "main"], { cwd: h.services.projects.get(real.id).mirrorPath }).toString();
    assert.match(files, /results\.md/, "what the experiment found starts the repository");
    await ticket(h, next.body.key, (x) => x.status === "needs_you", "the feature ticket started");
    assert.match(h.services.missions.view(h.services.tickets.view(next.body.key).missionId!).intent, /started as SBX-1 \(an experiment\)/);
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/promote`, {}, cookie)).status, 409, "only once");
  });
});
