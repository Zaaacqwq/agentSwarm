import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TicketView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { until } from "./fake-discord.ts";
import { REFUSAL } from "../src/models/backup.ts";
import { RESEARCH_LIMITS } from "../src/missions/mission-service.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const report = (summary: string) => call("report", { summary, tests: "-", unfinished: [] });
const refused = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 data_inspection_failed: Input data may contain inappropriate content." });
const lastToolResult = (c: TranscriptContext) => JSON.stringify(c.messages.at(-1) ?? "");
const errors = (h: Harness, runId: string) => h.services.runs.events(runId).filter((e) => e.type === "error").map((e) => String(e.data.message));

describe("when the model refuses or fails", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("moderation refusals are recognised; outages are not", () => {
    for (const e of ["400 data_inspection_failed", "Input data may contain inappropriate content", "content_filter", "The response was flagged by moderation"]) assert.ok(REFUSAL.test(e), e);
    for (const e of ["upstream 502", "connection refused", "rate limited", "Request timed out", "account flagged for unusual usage"]) assert.ok(!REFUSAL.test(e), e);
  });

  test("a refusal switches to the backup model at once, and the run stays on it", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    const endpointId = h.services.agents.get(agentId).endpointId;
    assert.deepEqual((await h.api("GET", "/api/models/settings", undefined, cookie)).body, { backup: null });
    assert.equal((await h.api("PUT", "/api/models/settings", { backup: { endpointId, modelId: "backup/model" } }, cookie)).status, 200);
    const seen: string[] = [];
    const answer = (text: string): FauxResponseFactory => (_c, _o, _s, model) => {
      seen.push(model.id);
      return report(text);
    };
    h.script([refused(), answer("done on the backup"), answer("follow-up on the backup")]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Touchy", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.equal(done.report?.summary, "done on the backup");
    const errs = errors(h, run.id);
    assert.ok(errs.some((m) => /data_inspection_failed.*switching to the backup model backup\/model/.test(m)), errs.join("\n"));
    assert.ok(!errs.some((m) => /retry 1/.test(m)), "a refusal is not retried on the same model");
    await h.api("POST", `/api/runs/${run.id}/messages`, { text: "One more thing." }, cookie);
    await until(() => h.services.runs.get(run.id).report?.summary === "follow-up on the backup");
    assert.deepEqual(seen, ["backup/model", "backup/model"]);
  });

  test("with no backup model, a refusal fails the run without pointless retries", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    h.script([refused()]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Touchy", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /data_inspection_failed/);
    assert.equal(errors(h, run.id).filter((m) => /retry/.test(m)).length, 0);
  });

  test("an outage is retried first, then the backup model takes over", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await h.api("PUT", "/api/models/settings", { backup: { endpointId: h.services.agents.get(agentId).endpointId, modelId: "backup/model" } }, cookie);
    const down = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503" });
    h.script([down(), down(), down(), report("after the switch")]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Down", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.deepEqual(errors(h, run.id).map((m) => /retry \d|switching/.exec(m)?.[0]), ["retry 1", "retry 2", "switching"]);
  });
  test("the same model on another endpoint is a backup too", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    const other = (await h.api("POST", "/api/endpoints", { name: "Direct", kind: "openrouter", apiKey: "sk-or-other-key" }, cookie)).body;
    await h.api("PUT", "/api/models/settings", { backup: { endpointId: other.id, modelId: "fake-model" } }, cookie);
    h.script([refused(), report("answered by the other endpoint")]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Touchy", brief: "x" }, cookie)).body;
    const done = await h.services.runs.settled(run.id);
    assert.equal(done.status, "succeeded", done.error ?? "");
  });

  test("a backup that fails too is retried, then the run fails; later executions start on the agent's own model again", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    await h.api("PUT", "/api/models/settings", { backup: { endpointId: h.services.agents.get(agentId).endpointId, modelId: "backup/model" } }, cookie);
    const down = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503" });
    let model = "";
    h.script([refused(), down(), down(), down(), (_c, _o, _s, m) => {
      model = m.id;
      return report("back on its own model");
    }]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Touchy", brief: "x" }, cookie)).body;
    const failed = await h.services.runs.settled(run.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual(errors(h, run.id).map((m) => /retry \d|switching/.exec(m)?.[0]).filter(Boolean), ["switching", "retry 1", "retry 2"]);
    await h.api("POST", `/api/runs/${run.id}/messages`, { text: "Try again." }, cookie);
    await until(() => h.services.runs.get(run.id).report?.summary === "back on its own model");
    assert.equal(model, "fake-model");
  });
});

describe("a researcher's limits", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("after its searches are used, web_search tells it to report instead", async () => {
    h = await harness();
    const { cookie } = await h.ready();
    let last = "";
    let description = "";
    const searches = Array.from({ length: RESEARCH_LIMITS.search + 1 }, (_, i) => call("web_search", { query: `question part ${i}` }));
    h.scriptAgents({
      Lead: [
        call("stage_done", { summary: "One question." }),
        call("spawn_agent", { name: "R", role: "researcher", brief: "Find out how CSV quotes commas; report with links." }),
        call("wait_agents", {}),
        call("ask_user", { question: "Stop here?" }),
      ],
      R: [
        (c) => {
          description = JSON.stringify(c.messages[0]);
          return searches[0]!;
        },
        ...searches.slice(1),
        (c) => {
          last = lastToolResult(c);
          return report("Quote fields with commas.");
        },
      ],
    });
    const t = (await h.api("POST", "/api/tickets", { space: "ideas", kind: "research", title: "How does CSV quote commas?", description: "For a small tool.", status: "todo" }, cookie)).body as TicketView;
    await until(() => h.services.tickets.view(t.key).need === "answer", 30_000);
    assert.match(description, new RegExp(`at most ${RESEARCH_LIMITS.search} searches`));
    assert.match(last, new RegExp(`Not done: you have used all ${RESEARCH_LIMITS.search} searches. Do not search or read more`));
    assert.equal(h.web.searches.length, RESEARCH_LIMITS.search, "the extra search never reached the web");
  });
});
