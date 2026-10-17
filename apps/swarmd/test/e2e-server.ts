// Serves the built dashboard on top of the test harness (local workstations, a local "GitHub",
// scripted models) for Playwright. Each run replays the same tree: the root agent hands the fix to
// a helper, has it reviewed, merges it, pushes and opens the pull request.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness } from "./harness.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const helperId = (context: TranscriptContext) => /Spawned Helper: id (run_[0-9a-f]+)/.exec(JSON.stringify(context.messages))?.[1] ?? "missing";
const withHelper = (name: string): FauxResponseFactory => (context) => call(name, { id: helperId(context) });

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
  ],
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
