// Serves the built dashboard on top of the test harness (local workstations, a local "GitHub",
// scripted models) for Playwright. Each run replays the same tree: the root agent hands the fix to
// a helper, has it reviewed, merges it, pushes and opens the pull request. Then a fast-track mission
// started on the dashboard: the lead asks, you answer, it plans, you approve, it builds and opens a PR.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness } from "./harness.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const helperId = (context: TranscriptContext) => /Spawned Helper: id (run_[0-9a-f]+)/.exec(JSON.stringify(context.messages))?.[1] ?? "missing";
const withHelper = (name: string): FauxResponseFactory => (context) => call(name, { id: helperId(context) });
const docsOf = (c: TranscriptContext) => /Mission documents go in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const builderId = (c: TranscriptContext) => /Spawned Builder: id (run_[0-9a-f]+)/.exec(JSON.stringify(c.messages))?.[1] ?? "missing";

const h = await harness({ webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)) });
h.scriptAgents({
  Dev: [
    call("spawn_agent", { name: "Helper", role: "developer", brief: "square(3) must be 9: fix math.js, run node --test, commit, push and report." }),
    call("wait_agents", {}),
    withHelper("review_agent"),
    withHelper("merge_agent"),
    call("ws_bash", { command: "node --test" }),
    call("git_push", {}),
    call("open_pull_request", { title: "Fix square", body: "square multiplied instead of added." }),
    call("report", { summary: "square now multiplies; the test passes.", tests: "node --test: 1 passed", unfinished: [] }),
    // The mission (fast track).
    call("ask_user", { question: "Should cube(2) return 8, and does it go in math.js?" }),
    call("stage_done", { summary: "Goal: add cube(x) to math.js with a test." }),
    writeDoc("plan.md", "# Plan\n\n1. Builder: add cube(x) to math.js and a test. Accept: cube(2) === 8.\n"),
    call("git_commit", { message: "Plan" }),
    call("git_push", {}),
    call("request_approval", { summary: "One package: cube(x) in math.js, tested with node --test." }),
    call("spawn_agent", { name: "Builder", role: "developer", brief: "Add cube(x) to math.js exporting it, with a test cube(2) === 8; commit and push." }),
    call("wait_agents", {}),
    (c) => call("review_agent", { id: builderId(c) }),
    (c) => call("merge_agent", { id: builderId(c) }),
    call("git_push", {}),
    call("stage_done", { summary: "cube is built and merged." }),
    writeDoc("acceptance.md", "# Acceptance\n\n- cube(2) === 8: pass.\n"),
    call("git_commit", { message: "Acceptance" }),
    call("git_push", {}),
    call("open_pull_request", { title: "Add cube", body: "See docs/agentswarm." }),
    call("stage_done", { summary: "Checked; the pull request is open." }),
  ],
  Builder: [
    call("ws_write", { path: "cube.js", content: "export const cube = (x) => x * x * x;\n" }),
    call("git_commit", { message: "Add cube" }),
    call("git_push", {}),
    call("report", { summary: "Added cube.", tests: "node --test: ok", unfinished: [] }),
  ],
  "Builder-review": [call("review_verdict", { approved: true, comments: "Correct." })],
  Helper: [
    call("ws_read", { path: "math.js" }),
    call("ws_edit", { path: "math.js", old_text: "x + x", new_text: "x * x" }),
    call("ws_bash", { command: "node --test" }),
    call("git_commit", { message: "Fix square" }),
    call("git_push", {}),
    call("report", { summary: "Fixed square.", tests: "node --test: 1 passed", unfinished: [] }),
  ],
  "Helper-review": [call("review_verdict", { approved: true, comments: "Correct, and the test passes." })],
});
await h.app.listen({ host: "127.0.0.1", port: Number(process.env.E2E_PORT ?? 4399) });
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
