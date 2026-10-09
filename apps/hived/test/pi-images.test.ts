import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineHiveTool, type AgentContext } from "@hive/tools";
import { PiRuntime } from "../src/agents/runtime/pi-runtime.ts";
import { pruneEntryImages, pruneImages } from "../src/agents/runtime/images.ts";
import { OpenRouterCatalog } from "../src/agents/runtime/model-catalog.ts";
import { startFakeOpenAI, type RecordedRequest } from "./fake-openai.ts";

let stop: () => void = () => {};
afterEach(() => stop());

const PIXEL = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAAsIAAEAAQEBEQD/xAAUAAEAAAAAAAAAAAAAAAAAAAAD/9oACAEBAAA/AH//2Q==", "base64").toString("base64");

const shotTool = defineHiveTool({
  name: "take_shot", label: "Shot", access: "r", description: "Takes a screenshot.", parameters: Type.Object({}),
  execute: async () => ({ text: "screenshot attached", images: [{ data: PIXEL, mimeType: "image/jpeg" as const }], details: { screenshotId: "shot_1" } }),
});

function imageParts(req: RecordedRequest): number {
  return req.body.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string }[]) : [])).filter((c) => c.type === "image_url").length;
}

async function turn(runtime: PiRuntime, baseUrl: string, kind: "openrouter" | "openai-compatible", events: unknown[], entries: readonly unknown[] | null = null) {
  const context: AgentContext = { agentId: "agt_1", orgId: "org_1", runId: "run_1", grants: [], currentGrants: () => [] };
  return runtime.runTurn({
    agent: { id: "agt_1", name: "Ada", role: "operator", instructions: "", modelId: "vision/model", thinkingLevel: "off" },
    endpoint: { id: `ep_${kind}`, kind, baseUrl, apiKey: "k" },
    context, tools: [{ toolpackId: "test", tool: shotTool }], guidance: [], prompt: "look", sessionEntries: entries,
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  });
}

describe("screenshots reach vision models", () => {
  test("a vision model gets the tool image; a text model does not", async () => {
    let calls = 0;
    const fake = startFakeOpenAI((req) => (req.body.messages.at(-1)?.role === "user" && calls++ % 2 === 0 ? { kind: "tool", name: "take_shot", args: {} } : { kind: "text", text: "done" }), 0, [
      { id: "vision/model", architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.000001", completion: "0.000002" }, context_length: 64000 },
    ]);
    stop = fake.stop;
    const runtime = await PiRuntime.create(mkdtempSync(join(tmpdir(), "hive-pi-img-")), new OpenRouterCatalog());
    const events: { kind: string; screenshotId?: string }[] = [];
    const result = await turn(runtime, fake.url, "openrouter", events);
    expect(imageParts(fake.requests[1]!)).toBe(1);
    expect(events.find((e) => e.kind === "tool_result")?.screenshotId).toBe("shot_1");
    const usage = events.find((e) => e.kind === "usage") as { costUsd: number } | undefined;
    expect(usage?.costUsd).toBeGreaterThan(0);

    // The same model behind a plain OpenAI-compatible endpoint is assumed text-only.
    const before = fake.requests.length;
    await turn(runtime, fake.url, "openai-compatible", []);
    expect(fake.requests.slice(before).every((r) => imageParts(r) === 0)).toBe(true);
    expect(result.sessionEntries.length).toBeGreaterThan(0);
  });

  test("only the newest images are kept in context and checkpoints", () => {
    const tool = (n: number) => ({ role: "toolResult", content: [{ type: "text", text: `t${n}` }, { type: "image", data: `img${n}`, mimeType: "image/jpeg" }] });
    const messages = [tool(1), { role: "user", content: "hi" }, tool(2), tool(3)];
    const pruned = pruneImages(messages, 2);
    expect(JSON.stringify(pruned[0])).not.toContain("img1");
    expect(JSON.stringify(pruned[0])).toContain("earlier screenshot removed");
    expect(JSON.stringify(pruned.slice(2))).toContain("img2");
    expect(JSON.stringify(pruned.slice(2))).toContain("img3");
    expect(messages[0]).toEqual(tool(1));
    const entries = [{ type: "session" }, ...messages.map((message) => ({ type: "message", message }))];
    const prunedEntries = pruneEntryImages(entries, 1) as { message?: unknown }[];
    expect(JSON.stringify(prunedEntries)).not.toContain("img2");
    expect(JSON.stringify(prunedEntries)).toContain("img3");
    expect(prunedEntries[0] as unknown).toBe(entries[0]);
  });

  test("catalog failures fall back to text-only", async () => {
    const catalog = new OpenRouterCatalog((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    expect(await catalog.facts("https://example.invalid/api/v1", "x/y")).toBeNull();
  });
});
