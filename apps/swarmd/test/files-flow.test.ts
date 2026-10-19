import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { InboxFileView, OutputFileView, TicketFileView, TicketView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const docsOf = (c: TranscriptContext) => /in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const commitPush = (message: string) => [call("git_commit", { message }), call("git_push", {})];

async function ticket(h: Harness, key: string, cond: (t: TicketView) => boolean, what: string): Promise<TicketView> {
  await until(() => cond(h.services.tickets.view(key)), 30_000).catch(() => {
    const t = h.services.tickets.view(key);
    throw new Error(`${key} is ${t.status} (stage ${t.stage}, need ${t.need}), wanted ${what}`);
  });
  return h.services.tickets.view(key);
}

describe("R10: files in, results out", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("files from an upload and from the inbox reach the lead under inputs/, stay out of commits; outputs/ comes back one by one and as a zip", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    const inbox = join(h.base, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "paper.pdf"), "%PDF-1.4\n% an assignment\n");
    writeFileSync(join(inbox, ".DS_Store"), "x");
    symlinkSync("/etc/hosts", join(inbox, "link.txt"));
    let read = "";
    let size = "";
    let brief = "";
    h.scriptAgents({
      Lead: [
        (c) => {
          brief = JSON.stringify(c.messages);
          return call("ws_read", { path: "inputs/notes.txt" });
        },
        (c) => {
          read = JSON.stringify(c.messages.at(-1) ?? "");
          return call("ws_bash", { command: "wc -c < inputs/data.csv; shasum -a 256 inputs/data.csv" });
        },
        (c) => {
          size = JSON.stringify(c.messages.at(-1) ?? "");
          return call("ws_write", { path: "outputs/answer.md", content: "# Answer\n2 + 3 = 5\n" });
        },
        writeDoc("results.md", "# Results\nThe answer is in outputs/answer.md.\n"), ...commitPush("Answer"),
        call("stage_done", { summary: "5." }),
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "sandbox", kind: "quick", title: "Do the assignment", description: "Answer the question in the notes.", status: "backlog" }, cookie)).body as TicketView;
    const upload = (name: string, body: string | Buffer) => h.app.inject({ method: "POST", url: `/api/tickets/${t.key}/files?name=${encodeURIComponent(name)}`, payload: body, headers: { cookie, "content-type": "application/octet-stream" } });

    const notes = await upload("notes.txt", "Add 2 and 3.\n");
    assert.equal(notes.statusCode, 200, notes.body);
    // Bigger than one write to the workstation: it arrives in parts, whole.
    const big = Buffer.from("a,b\n".repeat(900_000));
    assert.equal((await upload("data.csv", big)).statusCode, 200);
    assert.equal((await upload("evil.pdf", Buffer.from([0x4d, 0x5a, 0x90, 0]))).statusCode, 400, "not what its name says");
    assert.equal((await upload("tool.exe", "MZ")).statusCode, 400, "a kind that is not allowed");

    const listed = (await h.api("GET", "/api/inbox", undefined, cookie)).body as InboxFileView[];
    assert.deepEqual(listed.map((f) => f.name), ["paper.pdf"], "plain files only: no hidden files, no links");
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/files/from-inbox`, { name: "link.txt" }, cookie)).status, 400);
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/files/from-inbox`, { name: "../inbox/paper.pdf" }, cookie)).status, 400);
    assert.equal((await h.api("POST", `/api/tickets/${t.key}/files/from-inbox`, { name: "paper.pdf" }, cookie)).status, 200);

    const files = h.services.tickets.view(t.key).files as TicketFileView[];
    assert.deepEqual(files.map((f) => f.name), ["notes.txt", "data.csv", "paper.pdf"]);
    const got = await h.app.inject({ method: "GET", url: files[0]!.url, headers: { cookie } });
    assert.deepEqual([got.statusCode, got.body, /attachment/.test(String(got.headers["content-disposition"]))], [200, "Add 2 and 3.\n", true]);
    assert.equal((await h.app.inject({ method: "GET", url: files[0]!.url })).statusCode, 401);

    await h.api("POST", `/api/tickets/${t.key}/move`, { status: "todo" }, cookie);
    const ready = await ticket(h, t.key, (x) => x.status === "review", "a result for you");
    assert.match(brief, /inputs\/: notes\.txt, data\.csv, paper\.pdf/);
    assert.match(size, new RegExp(`${big.length}[\\s\\S]*${createHash("sha256").update(big).digest("hex")}`), "the big file arrived whole");
    assert.match(read, /Add 2 and 3\./, "the lead read the uploaded file");
    assert.equal((await upload("late.txt", "too late")).statusCode, 409, "files go in before it starts");

    // The person's files never reached a commit.
    const root = h.services.tree.run(h.services.missions.row(ready.missionId!).rootRunId);
    const mirror = h.services.projects.get(ready.projectId!).mirrorPath;
    const tree = execFileSync("/usr/bin/git", ["ls-tree", "-r", "--name-only", `refs/heads/${root.branch}`], { cwd: mirror }).toString();
    assert.doesNotMatch(tree, /^inputs\//m);
    assert.match(tree, /^outputs\/answer\.md$/m);

    const outputs = (await h.api("GET", `/api/tickets/${t.key}/outputs`, undefined, cookie)).body as OutputFileView[];
    assert.deepEqual(outputs.map((o) => o.path).sort(), [`${h.services.missions.row(ready.missionId!).docsPath}/results.md`, "outputs/answer.md"].sort());
    const one = await h.app.inject({ method: "GET", url: `/api/tickets/${t.key}/outputs/file?path=outputs/answer.md`, headers: { cookie } });
    assert.deepEqual([one.statusCode, one.body], [200, "# Answer\n2 + 3 = 5\n"]);
    assert.equal((await h.app.inject({ method: "GET", url: `/api/tickets/${t.key}/outputs/file?path=README.md`, headers: { cookie } })).statusCode, 404, "only what the listing shows");
    const zip = await h.app.inject({ method: "GET", url: `/api/tickets/${t.key}/outputs.zip`, headers: { cookie } });
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.rawPayload.subarray(0, 2).toString("latin1"), "PK");
  });
});

describe("R10: tickets that wait for others", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("a blocked ticket waits until its blocker is done; no circles; a stopped blocker keeps it waiting", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    h.scriptAgents({
      Lead: [
        writeDoc("results.md", "# Results\nA.\n"), ...commitPush("A"), call("stage_done", { summary: "A works." }),
        writeDoc("results.md", "# Results\nB.\n"), ...commitPush("B"), call("stage_done", { summary: "B works." }),
      ],
    });
    const make = async (title: string, status: "backlog" | "todo", blockedBy: string[] = []) => {
      const res = await h.api("POST", "/api/tickets", { space: "sandbox", kind: "quick", title, description: "Try it.", status, blockedBy }, cookie);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body as TicketView;
    };
    const a = await make("Try A", "backlog");
    const b = await make("Try B", "todo", [a.key]);
    assert.deepEqual([b.blockedBy, b.blocked], [[a.key], true]);
    assert.equal((await h.api("PATCH", `/api/tickets/${a.key}`, { blockedBy: [b.key] }, cookie)).status, 400, "no circles");
    assert.equal((await h.api("PATCH", `/api/tickets/${b.key}`, { blockedBy: [b.key] }, cookie)).status, 400, "not itself");

    await h.api("POST", `/api/tickets/${a.key}/move`, { status: "todo" }, cookie);
    await ticket(h, a.key, (x) => x.status === "review", "A in review");
    assert.equal(h.services.tickets.view(b.key).missionId, null, "B waits while A is not done");
    await h.api("POST", `/api/tickets/${a.key}/finish`, {}, cookie);
    const started = await ticket(h, b.key, (x) => x.status === "review", "B started once A was done");
    assert.equal(started.blocked, false);

    const d = await make("Try D", "backlog");
    const c = await make("Try C", "todo", [d.key]);
    await h.api("POST", `/api/tickets/${d.key}/move`, { status: "canceled" }, cookie);
    const after = h.services.tickets.view(c.key);
    assert.deepEqual([after.status, after.blocked, after.missionId], ["todo", true, null], "a stopped blocker does not let it start");
  });
});
