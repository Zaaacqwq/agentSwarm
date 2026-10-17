import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClaudeParser, CodexParser, toReport, type CliEvent } from "../src/cli/cli-events.ts";
import { deviceCode } from "../src/cli/cli-service.ts";
import { scanAddedLines } from "../src/relay/secret-scan.ts";

/** Event streams recorded from the real CLIs (Claude Code 2.1.302, Codex 0.163.0) fixing the same bug. */
const fixture = (name: string): unknown[] => readFileSync(new URL(`./fixtures/cli/${name}.jsonl`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const parseAll = (parser: { parse(e: unknown): CliEvent[] }, events: unknown[]) => events.flatMap((e) => parser.parse(e));
const of = <K extends CliEvent["kind"]>(events: CliEvent[], kind: K) => events.filter((e): e is Extract<CliEvent, { kind: K }> => e.kind === kind);

describe("CLI event streams", () => {
  test("Claude Code: session, paired tool calls, quota, the structured report and totals", () => {
    const events = parseAll(new ClaudeParser(() => 1000), fixture("claude-run"));
    assert.deepEqual(of(events, "session"), [{ kind: "session", id: "0c9b7741-096e-4aa1-bc31-c7b6ccd46b29", model: "claude-sonnet-5-5" }]);
    const starts = of(events, "tool_start");
    const ends = of(events, "tool_end");
    assert.deepEqual(starts.map((t) => t.name), ["Read", "Read", "Bash", "Edit", "Bash", "Bash"]);
    assert.deepEqual(ends.map((t) => t.id), starts.map((t) => t.id), "every call has its result, in order");
    assert.ok(!starts.some((t) => t.name === "StructuredOutput"), "the report tool is not shown as work");
    assert.match(ends.find((t) => t.name === "Bash" && t.output.includes("ok"))!.output, /^ok/);
    assert.equal(of(events, "turn").length, 5, "one per model message, not per content block");
    const quota = of(events, "quota").at(-1)!.quota;
    assert.equal(quota.fiveHour, 0.19, "the latest of the two");
    assert.equal(quota.sevenDay, 0.45);
    assert.equal(quota.fiveHourResetsAt, 1792268400 * 1000);
    const usage = of(events, "usage")[0]!;
    assert.equal(usage.turns, 8);
    assert.equal(usage.estimatedUsd, 0.047194);
    assert.ok(usage.tokensIn > 10_000 && usage.tokensOut > 100);
    const result = of(events, "result")[0]!;
    assert.equal(result.isError, false);
    assert.match(result.report!.summary, /Fixed add\(\)/);
    assert.match(result.report!.tests, /prints 'ok'/);
    assert.deepEqual(result.report!.unfinished, []);
  });

  test("Claude Code resumed: the same session, a plain-text answer and no report", () => {
    const events = parseAll(new ClaudeParser(), fixture("claude-resume"));
    assert.equal(of(events, "session")[0]!.id, "0c9b7741-096e-4aa1-bc31-c7b6ccd46b29");
    const result = of(events, "result")[0]!;
    assert.equal(result.report, null);
    assert.match(result.text, /6533080/);
  });

  test("Codex: thread, commands and file changes, the report from the last message, token usage", () => {
    const events = parseAll(new CodexParser(), fixture("codex-run"));
    assert.equal(of(events, "session")[0]!.id, "01a14ae8-1b09-7663-b855-8ae73f83915e");
    const starts = of(events, "tool_start");
    const ends = of(events, "tool_end");
    assert.deepEqual(starts.map((t) => t.name), ["shell", "shell", "shell", "edit", "shell", "shell"]);
    assert.deepEqual(ends.map((t) => t.id).sort(), starts.map((t) => t.id).sort());
    assert.match(ends.find((t) => t.name === "edit")!.output, /update .*math\.js/);
    assert.ok(ends.some((t) => t.name === "shell" && t.output.includes("(exit 0)")));
    const texts = of(events, "text").map((t) => t.text);
    assert.equal(texts.length, 2, "the JSON report is not shown as chat");
    const usage = of(events, "usage")[0]!;
    assert.equal(usage.tokensIn, 106589);
    assert.equal(usage.tokensOut, 794);
    assert.equal(usage.estimatedUsd, null);
    const result = of(events, "result")[0]!;
    assert.match(result.report!.summary, /Fixed `add`/);
    assert.equal(result.isError, false);
    assert.equal(of(parseAll(new CodexParser(), fixture("codex-resume")), "session")[0]!.id, "01a14ae8-1b09-7663-b855-8ae73f83915e");
  });

  test("failures and unknown events", () => {
    const claude = new ClaudeParser();
    assert.deepEqual(claude.parse({ type: "something_new", x: 1 }), []);
    assert.deepEqual(claude.parse("not an object"), []);
    const [, maxTurns] = claude.parse({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 80, usage: {} });
    assert.deepEqual(maxTurns, { kind: "result", report: null, text: "", isError: true, error: "Claude Code reached its turn limit" });
    const codex = new CodexParser();
    codex.parse({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "working on it" } });
    const [failed] = codex.parse({ type: "turn.failed", error: { message: "stream disconnected" } });
    assert.deepEqual(failed, { kind: "result", report: null, text: "working on it", isError: true, error: "stream disconnected" });
    assert.deepEqual(codex.parse({ type: "item.completed", item: { id: "item_2", type: "reasoning", text: "…" } }), []);
    assert.deepEqual(codex.parse({ type: "error", message: "Reconnecting… 1/5" }), [{ kind: "error", message: "Reconnecting… 1/5" }]);
  });

  test("reports: structured objects or their JSON text, and nothing else", () => {
    assert.deepEqual(toReport({ summary: " did it ", tests: "", unfinished: ["docs", 3, ""] }), { summary: "did it", tests: "(not reported)", unfinished: ["docs"] });
    assert.deepEqual(toReport('{"summary":"s","tests":"t","unfinished":[]}'), { summary: "s", tests: "t", unfinished: [] });
    for (const bad of ["plain text", "{broken", '{"tests":"t"}', { summary: "" }, null, 42]) assert.equal(toReport(bad), null, JSON.stringify(bad));
  });

  test("the Codex sign-in code and URL are read from what it prints", () => {
    assert.deepEqual(deviceCode(["1. Open this link in your browser", "   https://auth.openai.com/codex/device", "2. Enter this one-time code (expires in 15 minutes)", "   ABCD-12345"]), { url: "https://auth.openai.com/codex/device", code: "ABCD-12345" });
    assert.deepEqual(deviceCode(["Starting…"]), { url: null, code: null });
  });

  test("the Relay catches sign-in tokens shaped like JWTs, and Claude tokens", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc";
    assert.deepEqual(scanAddedLines(`+const t = "${jwt}";`), ["JSON Web Token"]);
    assert.deepEqual(scanAddedLines("+token=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz"), ["OpenAI/OpenRouter-style key"]);
    assert.deepEqual(scanAddedLines("+const header = 'eyJhbGciOi'; // not a whole token"), []);
  });
});
