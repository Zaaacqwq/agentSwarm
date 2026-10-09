import { describe, expect, test } from "bun:test";
import { createColleaguesPack, createCommunicationPack, type ChannelMessageView, type ChatPort } from "../src/index.ts";
import type { AgentContext } from "../src/toolpack.ts";

const ctx: AgentContext = { agentId: "agt_a", orgId: "org", runId: "run_1", grants: [], currentGrants: () => [] };

function fakeChat(overrides: Partial<ChatPort> = {}) {
  const sent: { channelId: string; body: string; replyToId?: number }[] = [];
  const history: ChannelMessageView[] = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, author: i % 2 ? "admin" : "Bob", authorKind: i % 2 ? "user" : "agent", body: `m${i + 1}`,
    replyToId: i === 29 ? 28 : null, reactions: i === 29 ? ["👍×2"] : [], createdAt: i,
  }));
  const port: ChatPort = {
    listChats: () => [
      { channelId: "ch_g", kind: "group", title: "Crew", members: ["admin", "Ada", "Bob"], canSend: true },
      { channelId: "ch_d", kind: "dm", title: "Ada", members: ["admin", "Ada"], canSend: false },
    ],
    send: (_c, input) => {
      sent.push(input);
      return { id: 100 + sent.length };
    },
    read: (_c, _ch, { before, limit }) => {
      const older = history.filter((m) => before === undefined || m.id < before);
      const page = older.slice(-limit);
      return { messages: page, hasMore: older.length > page.length };
    },
    searchFor: () => [{ ...history[0]!, channel: "Crew (ch_g)" }],
    reactAsAgent: () => {},
    directory: () => [{ id: "agt_b", name: "Bob", role: "builder" }],
    messageAgent: (_c, target) => ({ channelId: `ch_${target}`, id: 7 }),
    ...overrides,
  };
  return { port, sent };
}

function tool(port: ChatPort, name: string) {
  const all = [...createCommunicationPack(port).tools(ctx), ...createColleaguesPack(port).tools(ctx)];
  const t = all.find((x) => x.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

describe("core.communication", () => {
  test("send_message trims, passes reply_to, and surfaces policy errors", async () => {
    const { port, sent } = fakeChat();
    expect((await tool(port, "send_message").execute(ctx, { channel_id: "ch_g", body: "  hi  ", reply_to: 3 })).text).toBe("Sent message 101.");
    expect(sent).toEqual([{ channelId: "ch_g", body: "hi", replyToId: 3 }]);
    expect((await tool(port, "send_message").execute(ctx, { channel_id: "ch_g", body: "   " })).isError).toBe(true);
    const refusing = fakeChat({ send: () => { throw new Error("This conversation is paused"); } }).port;
    expect(await tool(refusing, "send_message").execute(ctx, { channel_id: "ch_g", body: "x" })).toEqual({ text: "This conversation is paused", isError: true });
  });

  test("read_channel shows authors, replies, reactions and paging", async () => {
    const { port } = fakeChat();
    const res = await tool(port, "read_channel").execute(ctx, { channel_id: "ch_g", limit: 5 });
    expect(res.text).toContain("#26 admin: m26");
    expect(res.text).toContain("#27 Bob (agent): m27");
    expect(res.text).toContain("#30 admin (reply to #28): m30  [👍×2]");
    expect(res.text).toContain("use before=26");
    expect((await tool(port, "read_channel").execute(ctx, { channel_id: "ch_g", before: 1 })).text).toBe("No messages.");
  });

  test("list_chats, search, react", async () => {
    const { port } = fakeChat();
    const chats = (await tool(port, "list_chats").execute(ctx, {})).text;
    expect(chats).toContain("ch_g · group · Crew");
    expect(chats).toContain("read-only this turn");
    expect((await tool(port, "search_messages").execute(ctx, { query: "m1" })).text).toContain("[Crew (ch_g)] #1 Bob (agent): m1");
    expect((await tool(port, "react").execute(ctx, { message_id: 3, emoji: "👍" })).text).toBe("Reacted 👍 to #3.");
    const empty = fakeChat({ listChats: () => [], searchFor: () => [] }).port;
    expect((await tool(empty, "list_chats").execute(ctx, {})).text).toBe("You are not in any channels.");
    expect((await tool(empty, "search_messages").execute(ctx, { query: "x" })).text).toBe("No matches.");
  });
});

describe("core.colleagues", () => {
  test("directory and message_agent", async () => {
    const { port } = fakeChat();
    expect((await tool(port, "agent_directory").execute(ctx, {})).text).toBe("Bob — builder (agt_b)");
    expect((await tool(port, "message_agent").execute(ctx, { agent: "Bob", body: "hi" })).text).toBe("Sent message 7 in ch_Bob.");
    const nobody = fakeChat({ directory: () => [] }).port;
    expect((await tool(nobody, "agent_directory").execute(ctx, {})).text).toBe("You have no colleagues yet.");
  });

  test("packs declare guidance and are healthy", async () => {
    const { port } = fakeChat();
    expect(createCommunicationPack(port).guidance).toContain("@mentioned");
    expect(await createColleaguesPack(port).healthcheck()).toEqual({ available: true });
  });
});
