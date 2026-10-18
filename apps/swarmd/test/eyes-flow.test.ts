import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { harness, type Harness } from "./harness.ts";
import { trimTree } from "../../../packages/ws-exec/src/ops/sim.ts";
import { UI_FIXTURE } from "../../../packages/ws-exec/test/fake-sim.ts";
import { formatScreen, numberElements } from "../src/eyes/ui-tree.ts";
import { keepRecentImages } from "../src/eyes/images.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const done = (summary: string) => call("report", { summary, tests: "-", unfinished: [] });
const lastResult = (c: TranscriptContext) => c.messages.at(-1) as { role: string; content: { type: string; text?: string; data?: string }[] };
const toolNames = (c: TranscriptContext) => (c.tools ?? []).map((t) => t.name);

const screen = numberElements(trimTree(JSON.parse(readFileSync(UI_FIXTURE, "utf8"))));
const general = screen.elements.find((e) => e.label === "General")!;

describe("the screen as an agent reads it", () => {
  test("labelled and tappable elements get numbers and centres; containers do not", () => {
    assert.equal(screen.width, 402);
    assert.ok(general, formatScreen(screen));
    assert.ok(screen.elements.every((e) => e.label || e.value || e.id || /button|cell|switch|textfield|slider/i.test(e.type)));
    assert.ok(!screen.elements.some((e) => e.type === "Application"));
    const text = formatScreen(screen);
    assert.match(text, /^Screen 402×874 points/);
    assert.match(text, new RegExp(`\\[${general.n}\\] \\w+ "General"`));
    assert.equal(new Set(screen.elements.map((e) => `${e.type}${e.label}${e.center}`)).size, screen.elements.length, "no duplicates");
  });

  test("only the newest three screenshots stay in the context", () => {
    const shot = (n: number) => ({ role: "toolResult", toolCallId: `t${n}`, toolName: "sim_screenshot", isError: false, timestamp: n, content: [{ type: "text", text: `shot ${n}` }, { type: "image", data: `IMG${n}`, mimeType: "image/jpeg" }] });
    const messages = [shot(1), { role: "user", content: "hi", timestamp: 0 }, shot(2), shot(3), shot(4), shot(5)] as unknown as AgentMessage[];
    const kept = keepRecentImages(messages);
    const images = JSON.stringify(kept).match(/IMG\d/g);
    assert.deepEqual(images, ["IMG3", "IMG4", "IMG5"]);
    assert.match(JSON.stringify(kept[0]), /earlier screenshot was removed/);
    assert.match(JSON.stringify(messages[0]), /IMG1/, "the original is not changed");
  });
});

describe("eyes and hands in a run (fake simulator, real sandbox)", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("QA builds, runs, reads, taps and photographs the app; the lead never gets a simulator; it is erased at the end", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    let leadTools: string[] = [];
    let sawImage = false;
    let uiText = "";
    let cliRefused = "";
    h.scriptAgents({
      Dev: [
        (c) => {
          leadTools = toolNames(c);
          return call("spawn_agent", { name: "Coder", role: "developer", brief: "Change the settings screen title and check it in the simulator.", runtime: "claude_code", needs: ["simulator"] });
        },
        (c) => {
          cliRefused = JSON.stringify(lastResult(c));
          return call("spawn_agent", { name: "QA", role: "qa", brief: "Open Settings in the app, tap General, save a screenshot as evidence.", needs: ["simulator"] });
        },
        call("wait_agents", {}),
        done("QA checked it."),
      ],
      QA: [
        call("sim_build", { scheme: "Demo", project: "App.xcodeproj" }),
        call("sim_launch", {}),
        call("sim_ui", {}),
        (c) => {
          uiText = JSON.stringify(lastResult(c));
          return call("sim_tap", { element: general.n });
        },
        call("sim_screenshot", { save_as: "docs/agentswarm/demo/screenshots/01-general.jpg" }),
        (c) => {
          sawImage = lastResult(c).content.some((x) => x.type === "image" && (x.data?.length ?? 0) > 100);
          return call("git_commit", { message: "QA screenshots" });
        },
        call("git_push", {}),
        done("General opens. Screenshot: docs/agentswarm/demo/screenshots/01-general.jpg"),
      ],
    });
    const lead = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Look", brief: "Get QA to check the app." }, cookie)).body;
    await h.services.runs.settled(lead.id);
    const tree = h.services.runs.tree(lead.treeId);
    const qa = tree.nodes.find((n) => n.title === "QA")!;
    assert.equal(h.services.runs.view(lead.id).status, "succeeded");
    assert.equal(qa.status, "succeeded", qa.error ?? "");

    assert.ok(!leadTools.some((t) => t.startsWith("sim_")), "the lead has no simulator");
    assert.match(cliRefused, /for native agents/);
    assert.ok(!tree.nodes.some((n) => n.title === "Coder"), "nothing was spawned for the refused request");
    assert.deepEqual(qa.needs, ["simulator"]);
    assert.match(uiText, new RegExp(`\\[${general.n}\\] \\w+ \\\\"General\\\\"`));
    assert.ok(sawImage, "the screenshot reached the model as an image");

    const events = h.services.runs.events(qa.id, 0);
    const shotEnd = events.find((e) => e.type === "tool_end" && e.data.name === "sim_screenshot")!;
    assert.match(String(shotEnd.data.screen), new RegExp(`^/api/runs/${qa.id}/screens/\\d{3}\\.jpg$`));
    const viaInject = await h.app.inject({ method: "GET", url: String(shotEnd.data.screen), headers: { cookie } });
    assert.equal(viaInject.statusCode, 200);
    assert.equal(viaInject.headers["content-type"], "image/jpeg");
    assert.equal(viaInject.rawPayload[0], 0xff);
    assert.equal((await h.app.inject({ method: "GET", url: String(shotEnd.data.screen) })).statusCode, 401, "only for the signed-in person");
    assert.equal((await h.app.inject({ method: "GET", url: `/api/runs/${qa.id}/screens/..%2F..%2Fagentswarm.db`, headers: { cookie } })).statusCode, 404);

    // Its workstation is released (simulator erased, processes reaped) just after it finishes.
    for (let i = 0; i < 200 && h.services.runs.isActive(qa.id); i++) await new Promise((r) => setTimeout(r, 25));
    const calls = h.sim(qa.workstationId!).calls();
    const tap = calls.find((c) => c[0] === "axe" && c[1] === "tap")!;
    assert.deepEqual(tap.slice(2, 6), ["-x", String(general.center[0]), "-y", String(general.center[1])]);
    assert.ok(calls.some((c) => c[1] === "erase"), `the device was erased when QA finished: ${JSON.stringify(calls.map((c) => c.slice(0, 2)))}`);
    const files = execFileSync("/usr/bin/git", ["--git-dir", h.remote, "ls-tree", "-r", "--name-only", qa.branch]).toString();
    assert.match(files, /docs\/agentswarm\/demo\/screenshots\/01-general\.jpg/, "the evidence was pushed");
  });

  test("simulator runs wait for a heavy slot and for memory; other runs do not", async () => {
    let pressure = 2;
    h = await harness({ maxConcurrentRuns: 4, heavySlots: 1, memoryPressure: () => pressure });
    const { cookie, agentId } = await h.ready();
    let maxHeavy = 0;
    const watch = () => {
      maxHeavy = Math.max(maxHeavy, h.services.runs.load().heavyRunning);
      return done("looked");
    };
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "A", role: "qa", brief: "Look at the app on the simulator and report.", needs: ["simulator"] }),
        call("spawn_agent", { name: "B", role: "qa", brief: "Look at the app on the simulator and report.", needs: ["simulator"] }),
        call("spawn_agent", { name: "C", role: "developer", brief: "Write notes.txt with the word ok, no simulator needed." }),
        call("wait_agents", {}),
        done("all done"),
      ],
      A: [call("sim_ui", {}), watch],
      B: [call("sim_ui", {}), watch],
      C: [done("notes written")],
    });
    const lead = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Two looks", brief: "Spawn them." }, cookie)).body;
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(cond());
    };
    const node = (title: string) => h.services.runs.tree(lead.treeId).nodes.find((n) => n.title === title);
    await until(() => node("C")?.status === "succeeded");
    assert.equal(node("A")!.status, "queued", "memory is tight: simulator runs wait");
    assert.equal(node("B")!.status, "queued");
    assert.deepEqual({ ...h.services.runs.load(), memoryPressure: 0 }, { heavySlots: 1, heavyRunning: 0, heavyQueued: 2, memoryPressure: 0 });
    pressure = 1;
    h.services.runs.schedule();
    await h.services.runs.settled(lead.id);
    assert.equal(node("A")!.status, "succeeded");
    assert.equal(node("B")!.status, "succeeded");
    assert.equal(maxHeavy, 1, "one simulator run at a time");
  });
});
