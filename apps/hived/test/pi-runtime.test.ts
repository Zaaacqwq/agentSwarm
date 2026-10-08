import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime, escapeConfigValue } from "../src/agents/runtime/pi-runtime.ts";
import { buildWorld } from "./fakes.ts";
import { startFakeOpenAI, type RecordedRequest } from "./fake-openai.ts";

const API_KEY = "sk-test-$HOME-key";
let stopServer: () => void = () => {};
afterEach(() => stopServer());

function lastUserText(req: RecordedRequest): string {
  const user = [...req.body.messages].reverse().find((m) => m.role === "user");
  if (typeof user?.content === "string") return user.content;
  const parts = Array.isArray(user?.content) ? (user.content as { type: string; text?: string }[]) : [];
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function channelIn(req: RecordedRequest): string | null {
  return /channel_id=(ch_[a-z0-9]+)/.exec(lastUserText(req))?.[1] ?? null;
}

async function piWorld(decide: Parameters<typeof startFakeOpenAI>[0]) {
  const fake = startFakeOpenAI(decide);
  stopServer = fake.stop;
  const runtime = await PiRuntime.create(mkdtempSync(join(tmpdir(), "hive-pi-")));
  const world = await buildWorld({ runtime, endpoint: { kind: "openai-compatible", baseUrl: fake.url, apiKey: API_KEY } });
  return { ...world, fake };
}

describe("PiRuntime against a fake OpenAI-compatible endpoint", () => {
  test("drives send_message, meters usage, and restores context on the next turn", async () => {
    const w = await piWorld((req) => {
      const last = req.body.messages.at(-1);
      if (last?.role === "tool") return { kind: "text", text: "internal note: replied" };
      return { kind: "tool", name: "send_message", args: { channel_id: channelIn(req), body: `echo: ${lastUserText(req).split(": ").pop()}` } };
    });
    const agent = w.makeAgent("Ada", undefined, "fake-model");
    const dm = w.chat.openDm(w.user, agent.id);

    w.chat.postUserMessage(w.user, dm.id, "cedar42");
    await w.manager.idle();
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.map((m) => m.body)).toEqual(["cedar42", "echo: cedar42"]);

    const first = w.fake.requests[0]!;
    expect(first.authorization).toBe(`Bearer ${API_KEY}`);
    expect(first.body.model).toBe("fake-model");
    expect(first.body.tools?.map((t) => t.function.name).sort()).toEqual(["read_channel", "send_message"]);
    const system = JSON.stringify(first.body.messages.filter((m) => m.role === "system" || m.role === "developer"));
    expect(system).toContain("You are Ada");
    expect(system).toContain("only send_message publishes");

    const [run] = w.runs.listRuns(w.user.orgId, agent.id);
    expect(run).toMatchObject({ status: "succeeded", inputTokens: 260, outputTokens: 20 });
    const activityKinds = w.runs.listActivity([run!.id]).map((a) => a.kind);
    expect(activityKinds).toEqual(["tool_call", "tool_result", "assistant_text"]);
    expect(JSON.stringify(w.chat.listMessages(w.user, dm.id, {}))).not.toContain("internal note");

    w.chat.postUserMessage(w.user, dm.id, "second");
    await w.manager.idle();
    const third = w.fake.requests[2]!;
    expect(JSON.stringify(third.body.messages)).toContain("cedar42");
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.at(-1)?.body).toBe("echo: second");
  });

  test("restores the session in a fresh runtime (simulated restart)", async () => {
    const w = await piWorld((req) => {
      const channel = channelIn(req);
      if (req.body.messages.at(-1)?.role === "tool" || !channel) return { kind: "text", text: "ok" };
      return { kind: "tool", name: "send_message", args: { channel_id: channel, body: "noted" } };
    });
    const agent = w.makeAgent("Ada", undefined, "fake-model");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "remember alpha73");
    await w.manager.idle();

    const entries = w.runs.loadSession(agent.id)!;
    const fresh = await PiRuntime.create(mkdtempSync(join(tmpdir(), "hive-pi-")));
    const seen: string[] = [];
    await fresh.runTurn({
      agent: { id: agent.id, name: "Ada", role: "dev", instructions: "", modelId: "fake-model", thinkingLevel: "off" },
      endpoint: await w.endpoints.resolveForRun(w.user.orgId, w.endpoint.id),
      context: { agentId: agent.id, orgId: w.user.orgId, runId: "run_x", grants: [], currentGrants: () => [] },
      tools: [],
      guidance: [],
      prompt: "what did I ask you to remember?",
      sessionEntries: entries,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e.kind),
    });
    expect(JSON.stringify(w.fake.requests.at(-1)!.body.messages)).toContain("alpha73");
    expect(seen).toContain("usage");
  });

  test("provider errors fail the run with the provider message", async () => {
    const w = await piWorld(() => ({ kind: "error", status: 400 }));
    const agent = w.makeAgent("Ada", undefined, "fake-model");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "hi");
    await w.manager.idle();
    const [run] = w.runs.listRuns(w.user.orgId, agent.id);
    expect(run?.status).toBe("failed");
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.at(-1)?.authorKind).toBe("system");
  });
});

describe("escapeConfigValue", () => {
  test("neutralises command and env syntax", () => {
    expect(escapeConfigValue("!rm -rf /")).toBe("$!rm -rf /");
    expect(escapeConfigValue("a$HOME")).toBe("a$$HOME");
    expect(escapeConfigValue("plain-key")).toBe("plain-key");
  });
});
