// R0 probe: a minimal Pi agent loop on Node 24 with OpenRouter, file tools and an image-returning tool.
//
//   node probe.mjs [model] [screenshot.png]
//
// Reads the OpenRouter key from ~/.pi/agent/auth.json (never printed). Works in a throwaway directory.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const [modelId = "qwen/qwen3.8-omni-flash", shot] = process.argv.slice(2);
process.env.OPENROUTER_API_KEY = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")).openrouter.key;

const models = createModels();
models.setProvider(openrouterProvider());
let model = models.getModel("openrouter", modelId);
if (!model) {
  await models.refresh({ providers: ["openrouter"] });
  model = models.getModel("openrouter", modelId);
}
if (!model) throw new Error(`${modelId} not in the OpenRouter list`);
console.log(`model ${model.id} · input ${JSON.stringify(model.input)} · context ${model.contextWindow}`);

const dir = mkdtempSync(join(tmpdir(), "r0-pi-"));
writeFileSync(join(dir, "math.js"), "export const square = (x) => x + x;\n");
const inside = (p) => {
  const full = join(dir, p);
  if (!full.startsWith(`${dir}/`)) throw new Error("Path is outside the workspace");
  return full;
};

const tools = [
  {
    name: "read_file", label: "Read file", description: "Read a file in the workspace.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, { path }) => ({ content: [{ type: "text", text: readFileSync(inside(path), "utf8") }], details: {} }),
  },
  {
    name: "write_file", label: "Write file", description: "Replace a file in the workspace.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, { path, content }) => {
      writeFileSync(inside(path), content);
      return { content: [{ type: "text", text: `Wrote ${path}` }], details: {} };
    },
  },
  ...(shot ? [{
    name: "screenshot", label: "Screenshot", description: "Take a screenshot of the phone simulator.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "image", data: readFileSync(shot).toString("base64"), mimeType: "image/png" }], details: {} }),
  }] : []),
];

const agent = new Agent({
  initialState: { systemPrompt: "You are a careful software agent. Use the tools; keep replies short.", model, tools },
  streamFn: models.streamSimple.bind(models),
});
const calls = [];
let cost = 0;
agent.subscribe((e) => {
  if (e.type === "tool_execution_start") calls.push(e.toolName);
  if (e.type === "message_end" && e.message.role === "assistant") cost += e.message.usage?.cost?.total ?? 0;
});

const t0 = Date.now();
await agent.prompt("math.js has a bug: square(x) must return x * x. Read it, fix it, then say what you changed.");
const fixed = readFileSync(join(dir, "math.js"), "utf8").includes("x * x");
console.log(`fix task: ${fixed ? "PASS" : "FAIL"} · tools ${calls.join(",")} · ${Date.now() - t0} ms`);

if (shot) {
  const t1 = Date.now();
  calls.length = 0;
  await agent.prompt("Take a screenshot. What is the page title, and name three items listed on it?");
  const last = agent.state.messages.at(-1);
  const text = last.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
  console.log(`vision task: tools ${calls.join(",")} · ${Date.now() - t1} ms\n  ${text.replace(/\s+/g, " ").slice(0, 300)}`);
}
console.log(`cost $${cost.toFixed(4)}`);
rmSync(dir, { recursive: true, force: true });
