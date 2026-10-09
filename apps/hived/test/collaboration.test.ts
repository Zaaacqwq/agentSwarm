import { describe, expect, test } from "bun:test";
import { COMMUNICATION_PACK_ID, COLLEAGUES_PACK_ID } from "@hive/tools";
import type { TurnInput } from "../src/agents/runtime/agent-runtime.ts";
import { parseMentions } from "../src/chat/mentions.ts";
import { isEmoji } from "../src/chat/chat-service.ts";
import { schema } from "../src/db/client.ts";
import { buildWorld, callTool, channelOf, waitForAbort } from "./fakes.ts";

const GRANTS = [
  { toolpackId: COMMUNICATION_PACK_ID, toolName: "*" },
  { toolpackId: COLLEAGUES_PACK_ID, toolName: "*" },
];

type World = Awaited<ReturnType<typeof buildWorld>>;
const say = async (input: TurnInput, channelId: string, body: string) => (await callTool(input, "send_message", { channel_id: channelId, body })).text;

async function crew(script: (input: TurnInput, w: World) => Promise<void>, limits = {}) {
  let world: World | null = null;
  const w = await buildWorld({ limits, script: (input) => script(input, world!) });
  world = w;
  const ada = w.makeAgent("Ada", GRANTS);
  const bob = w.makeAgent("Bob", GRANTS);
  const cy = w.makeAgent("Cy", GRANTS);
  return { w, ada, bob, cy };
}

describe("mentions", () => {
  test("longest name wins, boundaries respected, @all", () => {
    const c = [{ id: "a", name: "Ada" }, { id: "al", name: "Ada Lovelace" }, { id: "b", name: "Bob" }, { id: "z", name: "小明" }];
    expect(parseMentions("hi @Ada Lovelace and @bob!", c)).toEqual({ ids: ["al", "b"], all: false });
    expect(parseMentions("@Adam is not Ada", c)).toEqual({ ids: [], all: false });
    expect(parseMentions("mail me at x@bob.com", c)).toEqual({ ids: [], all: false });
    expect(parseMentions("@小明 请看", c)).toEqual({ ids: ["z"], all: false });
    expect(parseMentions("@all please", c)).toEqual({ ids: [], all: true });
  });

  test("emoji validation", () => {
    expect(isEmoji("👍")).toBe(true);
    expect(isEmoji("👩🏽‍💻")).toBe(true);
    expect(isEmoji("ok")).toBe(false);
    expect(isEmoji("👍👍")).toBe(false);
  });
});

describe("groups and wake rules", () => {
  test("only mentioned agents wake; @all wakes everyone; agents mention each other", async () => {
    const woke: string[] = [];
    const { w, ada, bob, cy } = await crew(async (input) => {
      woke.push(input.agent.name);
      if (input.agent.name === "Ada" && input.prompt.includes("hand off")) await say(input, channelOf(input), "@Bob your turn");
    });
    const group = w.chat.createGroup(w.user, "Crew", [ada.id, bob.id, cy.id]);
    w.chat.postUserMessage(w.user, group.id, "just chatting, nobody needs to act");
    await w.manager.idle();
    expect(woke).toEqual([]);

    w.chat.postUserMessage(w.user, group.id, "@Ada please hand off");
    await w.manager.idle();
    expect(woke).toEqual(["Ada", "Bob"]);

    woke.length = 0;
    w.chat.postUserMessage(w.user, group.id, "@all standup");
    await w.manager.idle();
    expect(woke.sort()).toEqual(["Ada", "Bob", "Cy"]);
    const [msg] = w.chat.listMessages(w.user, group.id, {}).messages.filter((m) => m.body === "@Bob your turn");
    expect(msg).toMatchObject({ authorName: "Ada", mentions: [bob.id] });
  });

  test("agents reach each other through agent DMs that people can read but not write", async () => {
    const seen: Record<string, string> = {};
    const { w, ada, bob } = await crew(async (input) => {
      if (input.agent.name === "Ada" && input.prompt.includes("(person)")) seen.ada = (await callTool(input, "message_agent", { agent: "bob", body: "can you check the build?" })).text;
      if (input.agent.name === "Bob") {
        seen.bobPrompt = input.prompt;
        await say(input, channelOf(input), "build is green");
      }
    });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "ask Bob about the build");
    await w.manager.idle();
    expect(seen.ada).toContain("Sent message");
    expect(seen.bobPrompt).toContain("private chat with an agent");
    expect(seen.bobPrompt).toContain("Ada (agent): can you check the build?");
    const agentDm = w.chat.listChannels(w.user).find((c) => c.kind === "agent_dm")!;
    expect(agentDm.title).toContain("↔");
    expect(w.chat.listMessages(w.user, agentDm.id, {}).messages.map((m) => m.body)).toEqual(["can you check the build?", "build is green"]);
    expect(() => w.chat.postUserMessage(w.user, agentDm.id, "let me in")).toThrow("read-only");
    expect(w.chat.channels.agentMembers(agentDm.id).sort()).toEqual([ada.id, bob.id].sort());
  });

  test("a turn started only by agents cannot post into a person's private chat", async () => {
    const results: string[] = [];
    let ownerDm = "";
    const { w, ada, bob } = await crew(async (input) => {
      if (input.agent.name === "Ada" && input.prompt.includes("(person)")) {
        await callTool(input, "message_agent", { agent: "Bob", body: "ping" });
      } else if (input.agent.name === "Bob") {
        results.push(await say(input, ownerDm, "sneaking into the owner's DM"));
      }
    });
    ownerDm = w.chat.openDm(w.user, bob.id).id;
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "go");
    await w.manager.idle();
    expect(results[0]).toContain("only post in your owner's private chat");
    expect(w.chat.listMessages(w.user, ownerDm, {}).messages).toHaveLength(0);
  });
});

describe("loop protection", () => {
  test("agent ping-pong pauses at the chain budget and a person's reply starts a new chain", async () => {
    let turns = 0;
    const { w, ada, bob } = await crew(async (input) => {
      turns++;
      if (input.agent.name === "Ada" && input.prompt.includes("(person)")) {
        await callTool(input, "message_agent", { agent: "Bob", body: "your move" });
        return;
      }
      await say(input, channelOf(input), `${input.agent.name}: your move`);
    });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "start a ping-pong with Bob");
    await w.manager.idle();
    const agentDm = w.chat.listChannels(w.user).find((c) => c.kind === "agent_dm")!;
    const msgs = w.chat.listMessages(w.user, agentDm.id, {}).messages;
    expect(msgs.filter((m) => m.authorKind === "agent")).toHaveLength(8);
    expect(msgs.at(-1)).toMatchObject({ authorKind: "system" });
    expect(msgs.at(-1)!.body).toContain("paused after 8 messages");
    expect(turns).toBeLessThan(15);
    expect(w.chat.chains.get(msgs[0]!.chainId!)!.pausedAt).not.toBeNull();
    void bob;
  });

  test("hourly rate limit per agent", async () => {
    const outcomes: string[] = [];
    const { w, ada } = await crew(async (input) => {
      for (let i = 0; i < 3; i++) outcomes.push(await say(input, channelOf(input), `msg ${i}`));
    });
    const dm = w.chat.openDm(w.user, ada.id);
    const now = Date.now();
    for (let i = 0; i < 59; i++) {
      w.handle.db.insert(schema.messages).values({ channelId: dm.id, authorKind: "agent", authorId: ada.id, authorName: "Ada", body: "old", runId: null, replyToId: null, chainId: null, mentions: [], createdAt: now - 1000 }).run();
    }
    w.chat.postUserMessage(w.user, dm.id, "talk");
    await w.manager.idle();
    expect(outcomes[0]).toContain("Sent");
    expect(outcomes[1]).toContain("Rate limit");
  });

  test("queue caps refuse agent deliveries to a swamped recipient", async () => {
    const replies: string[] = [];
    const { w, ada, bob } = await crew(async (input) => {
      if (input.agent.name === "Bob") return waitForAbort(input.signal);
      for (let i = 0; i < 3; i++) replies.push((await callTool(input, "message_agent", { agent: "Bob", body: `task ${i}` })).text);
    }, { maxPendingPerAgent: 2 });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, bob.id).id, "keep busy");
    await Bun.sleep(10);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "flood Bob");
    while (replies.length < 3) await Bun.sleep(5);
    expect(replies.slice(0, 2).every((r) => r.includes("Sent"))).toBe(true);
    expect(replies[2]).toContain("too many pending messages");
    w.manager.stop(bob.id);
    await w.manager.shutdown();
  });
});

describe("membership, reactions and search", () => {
  test("removed members stop receiving and cannot post", async () => {
    const results: string[] = [];
    let groupId = "";
    const { w, ada, bob } = await crew(async (input) => {
      if (input.agent.name === "Ada") results.push(await say(input, groupId, "still here?"));
    });
    groupId = w.chat.createGroup(w.user, "Crew", [ada.id, bob.id]).id;
    w.chat.updateGroup(w.user, groupId, { agentIds: [bob.id] });
    w.chat.postUserMessage(w.user, groupId, "@Ada hello");
    await w.manager.idle();
    expect(results).toEqual([]);
    expect(w.chat.channel(w.user, groupId).members.filter((m) => m.kind === "agent").map((m) => m.id)).toEqual([bob.id]);
    expect(() => w.chat.updateGroup(w.user, groupId, { agentIds: [] })).toThrow();
  });

  test("deleting an agent keeps the group and its history but removes its DMs", async () => {
    const { w, ada, bob } = await crew(async (input) => {
      await say(input, channelOf(input), `${input.agent.name} here`);
    });
    const group = w.chat.createGroup(w.user, "Crew", [ada.id, bob.id]);
    const dm = w.chat.openDm(w.user, ada.id);
    w.chat.postUserMessage(w.user, group.id, "@all roll call");
    await w.manager.idle();
    w.agents.remove(w.user, ada.id);
    const kept = w.chat.listMessages(w.user, group.id, {}).messages.map((m) => `${m.authorName}: ${m.body}`);
    expect(kept).toContain("Ada: Ada here");
    expect(w.chat.channel(w.user, group.id).members.filter((m) => m.kind === "agent").map((m) => m.id)).toEqual([bob.id]);
    expect(() => w.chat.channel(w.user, dm.id)).toThrow();
  });

  test("reactions are idempotent and agents react through the tool", async () => {
    const { w, ada } = await crew(async (input) => {
      const id = Number(/message #(\d+)/.exec(input.prompt)![1]);
      await callTool(input, "react", { message_id: id, emoji: "👀" });
    });
    const dm = w.chat.openDm(w.user, ada.id);
    const msg = w.chat.postUserMessage(w.user, dm.id, "look at this");
    w.chat.reactAsUser(w.user, msg.id, "👍", true);
    w.chat.reactAsUser(w.user, msg.id, "👍", true);
    await w.manager.idle();
    const after = w.chat.listMessages(w.user, dm.id, {}).messages[0]!;
    expect(after.reactions).toEqual([
      { emoji: "👍", actors: [{ kind: "user", id: w.user.id }] },
      { emoji: "👀", actors: [{ kind: "agent", id: ada.id }] },
    ]);
    w.chat.reactAsUser(w.user, msg.id, "👍", false);
    expect(w.chat.listMessages(w.user, dm.id, {}).messages[0]!.reactions.map((r) => r.emoji)).toEqual(["👀"]);
    expect(() => w.chat.reactAsUser(w.user, msg.id, "nope", true)).toThrow("single emoji");
  });

  test("search covers only readable channels, with trigram and short terms", async () => {
    const found: string[] = [];
    const { w, ada, bob } = await crew(async (input) => {
      found.push((await callTool(input, "search_messages", { query: "cedar" })).text);
    });
    const dmA = w.chat.openDm(w.user, ada.id);
    const dmB = w.chat.openDm(w.user, bob.id);
    w.handle.db.insert(schema.messages).values({ channelId: dmB.id, authorKind: "user", authorId: w.user.id, authorName: "admin", body: "secret cedar99 for Bob", runId: null, replyToId: null, chainId: null, mentions: [], createdAt: 1 }).run();
    w.chat.postUserMessage(w.user, dmA.id, "the word is cedar42, 我要换amd了");
    await w.manager.idle();
    expect(found[0]).toContain("cedar42");
    expect(found[0]).not.toContain("cedar99");
    expect(w.chat.searchForUser(w.user, "cedar").map((h) => h.message.body).sort()).toEqual(["secret cedar99 for Bob", "the word is cedar42, 我要换amd了"]);
    expect(w.chat.searchForUser(w.user, "amd 换").map((h) => h.channelTitle)).toEqual(["Ada"]);
    expect(w.chat.searchForUser(w.user, "cedar", dmB.id)).toHaveLength(1);
  });
});

describe("scheduling", () => {
  test("a burst of messages becomes one turn after the quiet period", async () => {
    const prompts: string[] = [];
    const { w, ada } = await crew(async (input) => {
      prompts.push(input.prompt);
    }, { debounceMs: 40 });
    const dm = w.chat.openDm(w.user, ada.id);
    for (const t of ["one", "two", "three"]) {
      w.chat.postUserMessage(w.user, dm.id, t);
      await Bun.sleep(10);
    }
    await w.manager.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("three");
  });

  test("two agents work in a group while a third answers its DM unblocked", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const { w, ada, bob, cy } = await crew(async (input) => {
      if (input.agent.name !== "Cy") await gate;
      await say(input, channelOf(input), `${input.agent.name} done`);
      done.push(input.agent.name);
    });
    const group = w.chat.createGroup(w.user, "Crew", [ada.id, bob.id]);
    w.chat.postUserMessage(w.user, group.id, "@Ada fix X, @Bob fix Y");
    await Bun.sleep(10);
    expect(w.manager.stateOf(ada.id)).toBe("working");
    expect(w.manager.stateOf(bob.id)).toBe("working");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, cy.id).id, "quick question");
    while (!done.includes("Cy")) await Bun.sleep(5);
    expect(done).toEqual(["Cy"]);
    release();
    await w.manager.idle();
    expect(done.sort()).toEqual(["Ada", "Bob", "Cy"]);
  });

  test("queue position and waiting reasons are published", async () => {
    const states: { agentId: string; queue?: { position: number; waitingFor: string | null } }[] = [];
    const { w, ada, bob } = await crew(async (input) => {
      await Bun.sleep(20);
      await say(input, channelOf(input), "ok");
    }, { maxConcurrentRuns: 1 });
    w.bus.subscribe(({ event }) => {
      if (event.type === "agent.state") states.push({ agentId: event.agentId, ...(event.queue ? { queue: event.queue } : {}) });
    });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "a");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, bob.id).id, "b");
    expect(w.manager.queueInfo(bob.id)).toEqual({ position: 1, waitingFor: "a free run slot" });
    w.manager.setWaiting(ada.id, "Bench 1 (held by Cy)");
    expect(w.manager.queueInfo(ada.id)).toEqual({ position: 0, waitingFor: "Bench 1 (held by Cy)" });
    await w.manager.idle();
    expect(states.some((s) => s.agentId === bob.id && s.queue?.position === 1)).toBe(true);
  });
});

describe("review fixes", () => {
  test("WebSocket events reach only people who can read the channel", async () => {
    const { buildApp } = await import("../src/app/build-app.ts");
    const { w, ada } = await crew(async () => {});
    // A second person in the same org (P6 will add a UI for this).
    const hash = await Bun.password.hash("second-user-password", { algorithm: "argon2id" });
    w.handle.db.insert(schema.users).values({ id: "usr_b", orgId: w.user.orgId, username: "bea", passwordHash: hash, role: "member", createdAt: 1 }).run();
    const bea = await w.auth.login({ username: "bea", password: "second-user-password" });
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const seen: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { cookie: `hive_session=${bea.token}` } });
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)).type);
    await new Promise((r) => (ws.onopen = r));
    const dm = w.chat.openDm(w.user, ada.id);
    w.chat.postUserMessage(w.user, dm.id, "private to admin");
    const group = w.chat.createGroup(w.user, "Admins only", [ada.id]);
    w.chat.postUserMessage(w.user, group.id, "also private");
    await w.manager.idle();
    await Bun.sleep(50);
    expect(seen.filter((t) => t.startsWith("message.") || t.startsWith("channel."))).toEqual([]);
    expect(seen).toContain("agent.state");
    ws.close();
    await app.close();
  });

  test("a stopped run stops waiting for a workstation lease", async () => {
    const { localBackend } = await import("./local-backend.ts");
    const results: string[] = [];
    let w!: World;
    w = await buildWorld({
      backend: localBackend().backend,
      leaseWaitMs: 10_000,
      script: async (input) => {
        results.push((await callTool(input, "ws_where", {})).text);
        results.push((await callTool(input, "ws_checkout", { repo: "nope", slug: "x" })).text);
      },
    });
    const ada = w.makeAgent("Ada", [...GRANTS, { toolpackId: "core.workstation", toolName: "*" }]);
    const ws = await w.workstations.create(w.user, { name: "Bench", osUser: "ws-1" });
    w.workstations.bind(w.user, ada.id, ws.id);
    w.leases.acquire({ resourceId: ws.id, agentId: "someone-else", runId: null });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "go");
    while (w.manager.queueInfo(ada.id)?.waitingFor === undefined) await Bun.sleep(5);
    expect(w.manager.queueInfo(ada.id)?.waitingFor).toContain("Bench");
    const started = Date.now();
    w.manager.stop(ada.id);
    await w.manager.idle();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(w.leases.current(ws.id)?.holderAgentId).toBe("someone-else");
  });

  test("a refused first message_agent leaves no empty agent DM", async () => {
    const results: string[] = [];
    const { w, ada } = await crew(async (input) => {
      results.push((await callTool(input, "message_agent", { agent: "Bob", body: "hi" })).text);
    }, { maxPendingPerAgent: 0 });
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "go");
    await w.manager.idle();
    expect(results[0]).toContain("too many pending");
    expect(w.chat.listChannels(w.user).filter((c) => c.kind === "agent_dm")).toHaveLength(0);
  });

  test("the debounce cannot postpone a turn forever", async () => {
    const started: number[] = [];
    const { w, ada } = await crew(async () => {
      started.push(Date.now());
    }, { debounceMs: 30 });
    const dm = w.chat.openDm(w.user, ada.id);
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      w.chat.postUserMessage(w.user, dm.id, `m${i}`);
      await Bun.sleep(20);
    }
    await w.manager.idle();
    expect(started[0]! - t0).toBeLessThan(200);
  });

  test("around paging respects small limits", async () => {
    const { w, ada } = await crew(async () => {});
    const dm = w.chat.openDm(w.user, ada.id);
    const ids = ["a", "b", "c", "d", "e"].map((b) => w.chat.postUserMessage(w.user, dm.id, b).id);
    await w.manager.shutdown();
    expect(w.chat.listMessages(w.user, dm.id, { around: ids[2]!, limit: 2 }).messages.map((m) => m.body)).toEqual(["b", "c"]);
    expect(w.chat.listMessages(w.user, dm.id, { around: ids[2]!, limit: 1 }).messages.map((m) => m.body)).toEqual(["c"]);
  });
});
