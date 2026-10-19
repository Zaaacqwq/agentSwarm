// Serves the built dashboard on top of the test harness (local workstations, a local "GitHub",
// scripted models) for Playwright. Each run replays the same tree: the root agent hands the fix to
// a helper, has it reviewed, merges it, pushes and opens the pull request. Then a fast-track mission
// started on the dashboard: the lead asks, you answer, it plans, you approve, it builds and opens a PR.
// Last, CLI workers (R4): a Claude Code token and a Codex sign-in, then a root that hands its fix to Claude Code.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness } from "./harness.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const helperId = (context: TranscriptContext) => /Spawned Helper: id (run_[0-9a-f]+)/.exec(JSON.stringify(context.messages))?.[1] ?? "missing";
const withHelper = (name: string): FauxResponseFactory => (context) => call(name, { id: helperId(context) });
const docsOf = (c: TranscriptContext) => /Mission documents go in (docs\/agentswarm\/[a-z0-9-]+)\//.exec(JSON.stringify(c))?.[1] ?? "docs/missing";
const writeDoc = (name: string, content: string): FauxResponseFactory => (c) => call("ws_write", { path: `${docsOf(c)}/${name}`, content });
const builderId = (c: TranscriptContext) => /Spawned Builder: id (run_[0-9a-f]+)/.exec(JSON.stringify(c.messages))?.[1] ?? "missing";

// Memory pressure is this Mac's, not the test's: simulator runs must not wait on whatever else is running.
const h = await harness({ webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)) });
h.scriptAgents({
  Dev: [
    call("spawn_agent", { name: "Helper", role: "developer", brief: "square(3) must be 9: fix math.js, run node --test, commit, push and report.", needs: ["simulator"] }),
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
    // CLI workers.
    call("spawn_agent", { name: "Claudia", role: "developer", brief: "square(3) must be 9: fix math.js so node --test passes.", runtime: "claude_code" }),
    call("wait_agents", {}),
    call("report", { summary: "Claude Code fixed square.", tests: "node --test: 1 passed", unfinished: [] }),
    // The board (R7): a ticket's lead asks, you answer, it asks again.
    call("ask_user", { question: "Which colour should the button be?" }),
    call("ask_user", { question: "Got it: orange. Anything else?" }),
  ],
  Builder: [
    call("ws_write", { path: "cube.js", content: "export const cube = (x) => x * x * x;\n" }),
    call("git_commit", { message: "Add cube" }),
    call("git_push", {}),
    call("report", { summary: "Added cube.", tests: "node --test: ok", unfinished: [] }),
  ],
  "Builder-review": [call("review_verdict", { approved: true, comments: "Correct." })],
  Helper: [
    // R6: what it saw, shown in the timeline (a fake simulator).
    call("sim_screenshot", {}),
    call("ws_read", { path: "math.js" }),
    call("ws_edit", { path: "math.js", old_text: "x + x", new_text: "x * x" }),
    call("ws_bash", { command: "node --test" }),
    call("git_commit", { message: "Fix square" }),
    call("git_push", {}),
    call("report", { summary: "Fixed square.", tests: "node --test: 1 passed", unfinished: [] }),
  ],
  "Helper-review": [call("review_verdict", { approved: true, comments: "Correct, and the test passes." })],
});
h.cli.script([{ write: [{ path: "math.js", content: "export const square = (x) => x * x;\n" }], commit: "Fix square", quota: { five: 0.42, seven: 0.18 }, usd: 0.0731, report: { summary: "square multiplies now.", tests: "node --test: 1 passed", unfinished: [] } }]);
// R8: what a retrospective would have left: an agent's lesson and a handbook change waiting for you.
// A lesson for the whole team waits as a suggestion until you approve it.
h.services.lessons.record({ scope: "team", title: "SwiftUI projects: build with sim_build, not plain swiftc", text: "The sandbox breaks Swift macros unless the build goes through the wrapper; sim_build does that." },
  { agent: "Lead", source: "FRI-3", missionId: "msn_e2e_retro", projectId: "prj_e2e", forbidden: [] });
h.services.handbooks.propose("Lead", "FRI-3", "qa", "Check the dark theme as well as the light one.", "A button was invisible in dark mode in FRI-3.");
// As swarmd does at startup: read the installed CLI versions and sign-ins.
await h.services.cli.refresh();
// The person confirms the Codex device code in their browser; here the fake does it a moment after the code shows.
h.services.bus.subscribe((m) => {
  if (m.kind === "cli" && m.cli.codex.workstations.some((w) => w.login?.state === "waiting" && w.login.code)) setTimeout(() => h.cli.approveLogin(), 1500);
});
await h.app.listen({ host: "127.0.0.1", port: Number(process.env.E2E_PORT ?? 4399) });
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
