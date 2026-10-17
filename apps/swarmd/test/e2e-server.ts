// Serves the built dashboard on top of the test harness (local workstations, a local "GitHub",
// a scripted model) for Playwright. Every run replays the same fix: read, edit, test, commit, push, report.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { harness } from "./harness.ts";

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const h = await harness({ webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)) });
h.script([
  call("ws_read", { path: "math.js" }),
  call("ws_edit", { path: "math.js", old_text: "x + x", new_text: "x * x" }),
  call("ws_bash", { command: "node --test" }),
  call("git_commit", { message: "Fix square" }),
  call("git_push", {}),
  call("report", { summary: "square now multiplies; the test passes.", tests: "node --test: 1 passed", unfinished: [] }),
]);
await h.app.listen({ host: "127.0.0.1", port: Number(process.env.E2E_PORT ?? 4399) });
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
