import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "../src/db/client.ts";
import { buildWorld, callTool, channelOf, usage, waitForAbort } from "./fakes.ts";

describe("AgentManager", () => {
  test("a DM wakes the agent; only send_message reaches chat; usage and session are saved", async () => {
    const w = await buildWorld({
      script: async (input) => {
        input.onEvent({ kind: "assistant_text", text: "raw model output that must stay private" });
        input.onEvent(usage(0.002));
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "pong" });
      },
    });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "ping");
    await w.manager.idle();

    const page = w.chat.listMessages(w.user, dm.id, {});
    expect(page.messages.map((m) => [m.authorKind, m.body])).toEqual([["user", "ping"], ["agent", "pong"]]);
    expect(JSON.stringify(page)).not.toContain("raw model output");

    const [run] = w.runs.listRuns(w.user.orgId, agent.id);
    expect(run).toMatchObject({ status: "succeeded", inputTokens: 100, outputTokens: 20, costUsd: 0.002 });
    expect(w.runs.usageSummary(w.user.orgId, agent.id)).toMatchObject({ runs: 1, costUsd: 0.002 });
    const kinds = w.runs.listActivity([run!.id]).map((a) => a.kind);
    expect(kinds).toEqual(["assistant_text", "tool_call", "tool_result"]);
    expect(w.runs.loadSession(agent.id)).toHaveLength(1);
    expect(w.runtime.calls[0]!.prompt).toContain("admin (user): ping");
    expect(w.manager.stateOf(agent.id)).toBe("idle");
    expect(w.events).toContain("activity.created");
  });

  test("two agents run independently and never share sessions or channels", async () => {
    const w = await buildWorld({
      script: async (input) => {
        await callTool(input, "send_message", { channel_id: channelOf(input), body: `${input.agent.name} heard: ${input.prompt.split(": ").pop()}` });
      },
    });
    const a = w.makeAgent("Ada");
    const b = w.makeAgent("Bob");
    const dmA = w.chat.openDm(w.user, a.id);
    const dmB = w.chat.openDm(w.user, b.id);
    w.chat.postUserMessage(w.user, dmA.id, "alpha");
    w.chat.postUserMessage(w.user, dmB.id, "beta");
    await w.manager.idle();

    expect(w.chat.listMessages(w.user, dmA.id, {}).messages.at(-1)?.body).toBe("Ada heard: alpha");
    expect(w.chat.listMessages(w.user, dmB.id, {}).messages.at(-1)?.body).toBe("Bob heard: beta");
    expect(JSON.stringify(w.runs.loadSession(a.id))).not.toContain("beta");
    expect(JSON.stringify(w.runs.loadSession(b.id))).not.toContain("alpha");
  });

  test("an agent cannot post into another agent's DM", async () => {
    let otherChannel = "";
    const w = await buildWorld({
      script: async (input) => {
        const res = await callTool(input, "send_message", { channel_id: otherChannel, body: "intrusion" });
        expect(res.isError).toBe(true);
      },
    });
    const a = w.makeAgent("Ada");
    const b = w.makeAgent("Bob");
    otherChannel = w.chat.openDm(w.user, b.id).id;
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, a.id).id, "go");
    await w.manager.idle();
    expect(w.chat.listMessages(w.user, otherChannel, {}).messages).toHaveLength(0);
  });

  test("messages sent while busy are delivered together at the next turn boundary", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const w = await buildWorld({
      script: async (input) => {
        if (w.runtime.calls.length === 1) await gate;
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "ok" });
      },
    });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "first");
    await Bun.sleep(0);
    expect(w.manager.stateOf(agent.id)).toBe("working");
    w.chat.postUserMessage(w.user, dm.id, "second");
    w.chat.postUserMessage(w.user, dm.id, "third");
    expect(w.runtime.calls).toHaveLength(1);
    release();
    await w.manager.idle();

    expect(w.runtime.calls).toHaveLength(2);
    expect(w.runtime.calls[1]!.prompt).toContain("second");
    expect(w.runtime.calls[1]!.prompt).toContain("third");
    expect(w.runs.listRuns(w.user.orgId, agent.id)).toHaveLength(2);
  });

  test("the global concurrency cap queues other agents", async () => {
    let running = 0;
    let peak = 0;
    const w = await buildWorld({
      limits: { maxConcurrentRuns: 1 },
      script: async (input) => {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(5);
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "done" });
        running--;
      },
    });
    const a = w.makeAgent("Ada");
    const b = w.makeAgent("Bob");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, a.id).id, "x");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, b.id).id, "y");
    expect(w.manager.stateOf(b.id)).toBe("queued");
    await w.manager.idle();
    expect(peak).toBe(1);
    expect(w.runtime.calls).toHaveLength(2);
  });

  test("a failing turn is recorded, reported in chat, and the agent recovers", async () => {
    const w = await buildWorld({
      script: async (input) => {
        if (w.runtime.calls.length === 1) throw new Error("provider returned 502");
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "back" });
      },
    });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "one");
    await w.manager.idle();
    const [failed] = w.runs.listRuns(w.user.orgId, agent.id);
    expect(failed).toMatchObject({ status: "failed", error: "provider returned 502" });
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.at(-1)).toMatchObject({ authorKind: "system", body: "Turn failed: provider returned 502" });
    expect(w.runs.loadSession(agent.id)).toBeNull();

    w.chat.postUserMessage(w.user, dm.id, "two");
    await w.manager.idle();
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.at(-1)?.body).toBe("back");
  });

  test("stop interrupts the active turn without saving its session", async () => {
    const w = await buildWorld({ script: (input) => waitForAbort(input.signal) });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "long task");
    await Bun.sleep(0);
    expect(w.manager.stop(agent.id)).toBe(true);
    await w.manager.idle();
    expect(w.runs.listRuns(w.user.orgId, agent.id)[0]).toMatchObject({ status: "interrupted", error: "stopped" });
    expect(w.manager.stop(agent.id)).toBe(false);
    expect(w.runs.loadSession(agent.id)).toBeNull();
  });

  test("timeouts and tool-call limits fail the turn", async () => {
    const slow = await buildWorld({ limits: { runTimeoutMs: 10 }, script: (input) => waitForAbort(input.signal) });
    const a = slow.makeAgent("Ada");
    slow.chat.postUserMessage(slow.user, slow.chat.openDm(slow.user, a.id).id, "x");
    await slow.manager.idle();
    expect(slow.runs.listRuns(slow.user.orgId, a.id)[0]).toMatchObject({ status: "failed", error: "The turn hit its time limit." });

    const chatty = await buildWorld({
      limits: { maxToolCallsPerRun: 2 },
      script: async (input) => {
        for (let i = 0; i < 5; i++) {
          if (input.signal.aborted) throw input.signal.reason;
          await callTool(input, "read_channel", { channel_id: channelOf(input) });
        }
      },
    });
    const b = chatty.makeAgent("Bob");
    chatty.chat.postUserMessage(chatty.user, chatty.chat.openDm(chatty.user, b.id).id, "x");
    await chatty.manager.idle();
    expect(chatty.runs.listRuns(chatty.user.orgId, b.id)[0]).toMatchObject({ status: "failed", error: "The turn hit its tool-call limit." });
  });

  test("an agent without communication grants gets no tools and a visible notice", async () => {
    const w = await buildWorld({ script: async (input) => expect(input.tools).toHaveLength(0) });
    const agent = w.makeAgent("Mute", []);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "hello?");
    await w.manager.idle();
    const [run] = w.runs.listRuns(w.user.orgId, agent.id);
    const notices = w.runs.listActivity([run!.id]).filter((a) => a.kind === "notice").map((a) => String(a.payload.text));
    expect(notices.some((t) => t.includes("send_message is not granted"))).toBe(true);
    expect(notices.some((t) => t.includes("without send_message"))).toBe(true);
  });

  test("revoking a grant mid-run denies the next tool call", async () => {
    const w = await buildWorld({
      script: async (input) => {
        w.agents.update(w.user, input.agent.id, { grants: [] });
        const res = await callTool(input, "send_message", { channel_id: channelOf(input), body: "should not land" });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("Permission denied");
      },
    });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "go");
    await w.manager.idle();
    expect(w.chat.listMessages(w.user, dm.id, {}).messages.map((m) => m.authorKind)).toEqual(["user"]);
  });

  test("a missing endpoint fails clearly", async () => {
    const w = await buildWorld();
    const agent = w.makeAgent("Ada");
    w.endpoints.remove(w.user, w.endpoint.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "hi");
    await w.manager.idle();
    expect(w.runs.listRuns(w.user.orgId, agent.id)[0]?.error).toContain("no model endpoint");
  });

  test("deleting a busy agent aborts its run quietly", async () => {
    const w = await buildWorld({ script: (input) => waitForAbort(input.signal) });
    const agent = w.makeAgent("Ada");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "work");
    await Bun.sleep(0);
    w.manager.onAgentDeleted(agent.id);
    w.agents.remove(w.user, agent.id);
    await w.manager.idle();
    expect(w.handle.db.select().from(schema.runs).all()).toHaveLength(0);
    expect(w.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  test("restart marks mid-flight runs interrupted and reschedules queued ones", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "hive-restart-")), "hive.db");
    const first = await buildWorld({ dbPath, limits: { maxConcurrentRuns: 1 }, script: (input) => waitForAbort(input.signal) });
    const a = first.makeAgent("Ada");
    const b = first.makeAgent("Bob");
    const dmA = first.chat.openDm(first.user, a.id);
    first.chat.postUserMessage(first.user, dmA.id, "in flight");
    first.chat.postUserMessage(first.user, first.chat.openDm(first.user, b.id).id, "waiting");
    await Bun.sleep(0);
    // Simulate a crash: the process dies without settling runs.
    first.handle.close();

    const second = await buildWorld({
      dbPath,
      script: async (input) => {
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "resumed" });
      },
    });
    await second.manager.idle();
    expect(second.runs.listRuns(second.user.orgId, a.id)[0]).toMatchObject({ status: "interrupted" });
    expect(second.chat.listMessages(second.user, dmA.id, {}).messages.at(-1)?.body).toContain("interrupted by a restart");
    expect(second.runs.listRuns(second.user.orgId, b.id)[0]).toMatchObject({ status: "succeeded" });
    expect(second.runtime.calls).toHaveLength(1);
  });
});
