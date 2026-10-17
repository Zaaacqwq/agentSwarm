import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MISSION_STAGES, type MissionStage } from "../src/db/schema.ts";
import { afterStageDone, canMove, requiredDocs, stageTools } from "../src/missions/stages.ts";
import { checkUrl, decodeEntities, fetchPage, htmlToText, isPublicAddress } from "../src/web/web-fetch.ts";
import { formatSearch, pageWindow } from "../src/web/web-access.ts";
import { splitMessage } from "../src/discord/transport.ts";
import { parsePullRequestUrl } from "../src/github/github-client.ts";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { clipToSchema } from "../src/agents/clip.ts";

describe("mission stages", () => {
  test("the lead moves through the working stages, the fast track skips research and discussion", () => {
    assert.equal(afterStageDone("intake", false), "research");
    assert.equal(afterStageDone("intake", true), "planning");
    assert.equal(afterStageDone("research", false), "discussion");
    assert.equal(afterStageDone("discussion", false), "planning");
    assert.equal(afterStageDone("planning", false), null, "planning only ends with request_approval");
    assert.equal(afterStageDone("building", false), "verifying");
    assert.equal(afterStageDone("verifying", false), "awaiting_merge");
    assert.equal(afterStageDone("awaiting_merge", false), null, "only GitHub ends this one");
    assert.equal(afterStageDone("retro", false), "done");
    assert.ok(canMove("intake", "planning", "lead", true));
    assert.ok(!canMove("intake", "planning", "lead", false));
    assert.ok(!canMove("intake", "research", "lead", true));
  });

  test("no one but the person passes the plan gate, and only GitHub the merge gate", () => {
    for (const by of ["lead", "github", "system"] as const) assert.ok(!canMove("awaiting_approval", "building", by), by);
    assert.ok(canMove("awaiting_approval", "building", "person"));
    assert.ok(canMove("awaiting_approval", "planning", "person"));
    for (const from of MISSION_STAGES) {
      // The lead can never reach building, retro or done's predecessor gates by itself.
      assert.ok(!canMove(from, "building", "lead"), `lead ${from} → building`);
      assert.ok(!canMove(from, "retro", "lead"), `lead ${from} → retro`);
      assert.ok(!canMove(from, "cancelled", "lead"), `lead ${from} → cancelled`);
    }
    assert.ok(canMove("awaiting_merge", "retro", "github"));
    assert.ok(!canMove("awaiting_merge", "retro", "person"));
    assert.ok(canMove("planning", "awaiting_approval", "lead"));
    for (const ended of ["done", "cancelled"] as MissionStage[]) {
      for (const to of MISSION_STAGES) for (const by of ["lead", "person", "github", "system"] as const) assert.ok(!canMove(ended, to, by));
    }
  });

  test("each stage has its tools and its documents", () => {
    assert.deepEqual(stageTools("intake"), { workstation: "read", tree: false, web: false, pullRequest: false, stageDone: true, requestApproval: false });
    assert.equal(stageTools("research").web, true);
    assert.equal(stageTools("building").web, false);
    assert.equal(stageTools("planning").stageDone, false);
    assert.equal(stageTools("planning").requestApproval, true);
    assert.equal(stageTools("verifying").pullRequest, true);
    assert.equal(stageTools("building").pullRequest, false);
    assert.deepEqual(requiredDocs("research"), ["research.md"]);
    assert.deepEqual(requiredDocs("verifying"), ["acceptance.md"]);
    assert.deepEqual(requiredDocs("building"), []);
  });
});

describe("web access", () => {
  test("only public https URLs", () => {
    assert.equal(checkUrl("https://example.com/a?b=1").host, "example.com");
    for (const bad of [
      "http://example.com/", "ftp://example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "https://localhost/",
      "https://127.0.0.1/", "https://10.1.2.3/", "https://192.168.1.1/", "https://169.254.169.254/latest/meta-data", "https://[::1]/",
      "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/", "https://intranet/", "https://printer.local/", "not a url", `https://example.com/?d=${"x".repeat(600)}`,
    ]) assert.throws(() => checkUrl(bad), Error, bad);
  });

  test("address ranges", () => {
    for (const ok of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(isPublicAddress(ok), ok);
    for (const bad of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "nonsense"]) {
      assert.ok(!isPublicAddress(bad), bad);
    }
  });

  test("a private address is refused before any connection", async () => {
    await assert.rejects(fetchPage("https://127.0.0.1/"), /not public/);
  });

  test("pages become readable text with their links", () => {
    const html = `<html><head><title>CSV &amp; Markdown</title><style>p{}</style></head><body><script>alert(1)</script>
      <h1>Title</h1><p>Hello&nbsp;<b>world</b> &#x263A; &#9731;</p><ul><li>one</li><li>two</li></ul>
      <a href="/docs">the docs</a> <a href="javascript:x">bad</a><!-- hidden --></body></html>`;
    const text = htmlToText(html, new URL("https://example.com/page"));
    assert.match(text, /^# Title/m);
    assert.match(text, /Hello world ☺ ☃/);
    assert.match(text, /^- one$/m);
    assert.match(text, /the docs \(https:\/\/example\.com\/docs\) bad$/m);
    assert.doesNotMatch(text, /alert|hidden|p\{\}|javascript/);
    assert.equal(decodeEntities("&lt;a&gt; &quot;x&quot; &#39;y&#39; &bogus;"), "<a> \"x\" 'y' &bogus;");
    const page = { url: "https://example.com", status: 200, title: "T", text: "x".repeat(50) };
    assert.match(pageWindow(page, 0, 20), /30 more characters; call web_fetch again with offset 20/);
    assert.doesNotMatch(pageWindow(page, 40, 20), /more characters/);
  });

  test("hostile pages cannot stall the parser (unclosed tags, comments and links)", () => {
    for (const unit of ["<script ", "<!--", "<a href=x ", "<title", "<a href=\"", "&aaaaaaaa", "<<<<"]) {
      const page = `<title>t</title>${unit.repeat(200_000)}<p>end</p>`;
      const t0 = performance.now();
      htmlToText(page, new URL("https://example.com"));
      const ms = performance.now() - t0;
      assert.ok(ms < 1500, `${JSON.stringify(unit)} took ${Math.round(ms)} ms`);
    }
    assert.equal(htmlToText("a < b and c > d"), "a < b and c > d");
    assert.equal(htmlToText("<script>if (a<b) x()</script>after"), "after");
  });

  test("search results keep titles, URLs and excerpts, without duplicates", () => {
    const text = formatSearch({
      choices: [{ message: { content: "Use a parser.", annotations: [
        { type: "url_citation", url_citation: { url: "https://a.example", title: "A", content: "first   excerpt" } },
        { type: "url_citation", url_citation: { url: "https://a.example", title: "A again" } },
        { type: "url_citation", url_citation: { url: "https://b.example" } },
      ] } }],
    });
    assert.equal(text, "Results:\n1. A\n   https://a.example\n   first excerpt\n2. https://b.example\n   https://b.example\n\nSummary:\nUse a parser.");
    assert.equal(formatSearch({}), "No results.");
  });
});

describe("discord and github helpers", () => {
  test("long messages split on line breaks under Discord's limit", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const parts = splitMessage(text, 500);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 500));
    assert.equal(parts.join("\n"), text);
    assert.deepEqual(splitMessage("y".repeat(1200), 500).map((p) => p.length), [500, 500, 200]);
    assert.deepEqual(splitMessage("  "), ["(empty)"]);
  });

  test("pull request URLs", () => {
    assert.deepEqual(parsePullRequestUrl("https://github.com/Zaaacqwq/agentswarm-playground/pull/12"), { repo: "Zaaacqwq/agentswarm-playground", number: 12 });
    assert.equal(parsePullRequestUrl("https://github.com/a/b/issues/1"), null);
    assert.equal(parsePullRequestUrl("https://evil.example/a/b/pull/1"), null);
  });

  test("over-long tool text is cut to the schema limit instead of rejected (no resend loop)", () => {
    const schema = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 400 }), notes: Type.Array(Type.String({ maxLength: 20 })), other: Type.Optional(Type.String({ maxLength: 10 })) });
    const clip = clipToSchema(schema);
    const ok = { summary: "short", notes: ["a"] };
    assert.equal(clip(ok), ok, "untouched arguments are returned as they are");
    const long = { summary: "s".repeat(1000), notes: ["n".repeat(50), "fine"], other: "o".repeat(30) };
    const out = clip(long);
    assert.equal(out.summary.length, 400);
    assert.match(out.summary, /600 characters cut/);
    assert.equal(out.notes[0].length, 20);
    assert.equal(out.notes[1], "fine");
    assert.equal(out.other.length, 10);
    assert.equal(long.summary.length, 1000, "the original is not changed");
    const args = validateToolArguments({ name: "report", description: "", parameters: schema } as any, { type: "toolCall", id: "1", name: "report", arguments: out } as any);
    assert.equal((args as any).summary.length, 400);
  });
});
