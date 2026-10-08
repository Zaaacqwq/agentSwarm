import { describe, expect, test } from "bun:test";
import { createCommunicationPack, type ChatPort, type ChannelMessageView } from "../src/index.ts";
import type { AgentContext } from "../src/toolpack.ts";

function fakeChat(members: Record<string, string[]>, history: ChannelMessageView[] = []) {
  const posted: { channelId: string; agentId: string; runId: string; body: string }[] = [];
  const port: ChatPort = {
    isMember: (channelId, agentId) => members[channelId]?.includes(agentId) ?? false,
    postAgentMessage: (input) => {
      posted.push(input);
      return { id: 100 + posted.length };
    },
    readChannel: (_channelId, { before, limit }) => {
      const older = history.filter((m) => before === undefined || m.id < before);
      const page = older.slice(-limit);
      return { messages: page, hasMore: older.length > page.length };
    },
  };
  return { port, posted };
}

const ctx: AgentContext = { agentId: "agt_a", orgId: "org", runId: "run_1", grants: [], currentGrants: () => [] };

function tool(port: ChatPort, name: string) {
  const t = createCommunicationPack(port).tools(ctx).find((x) => x.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

describe("core.communication", () => {
  test("send_message posts only to channels the agent belongs to", async () => {
    const { port, posted } = fakeChat({ ch_mine: ["agt_a"], ch_other: ["agt_b"] });
    const send = tool(port, "send_message");
    const ok = await send.execute(ctx, { channel_id: "ch_mine", body: "  hello  " });
    expect(ok.isError).toBeUndefined();
    expect(posted).toEqual([{ channelId: "ch_mine", agentId: "agt_a", runId: "run_1", body: "hello" }]);
    const denied = await send.execute(ctx, { channel_id: "ch_other", body: "sneaky" });
    expect(denied.isError).toBe(true);
    expect(posted).toHaveLength(1);
  });

  test("send_message rejects whitespace-only bodies", async () => {
    const { port, posted } = fakeChat({ ch: ["agt_a"] });
    const res = await tool(port, "send_message").execute(ctx, { channel_id: "ch", body: "   " });
    expect(res.isError).toBe(true);
    expect(posted).toHaveLength(0);
  });

  test("read_channel pages and truncates long bodies", async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      author: i % 2 ? "Admin" : "agent",
      authorKind: "user" as const,
      body: i === 29 ? "x".repeat(1500) : `m${i + 1}`,
      createdAt: i,
    }));
    const { port } = fakeChat({ ch: ["agt_a"] }, history);
    const read = tool(port, "read_channel");
    const res = await read.execute(ctx, { channel_id: "ch", limit: 5 });
    expect(res.text).toContain("#26");
    expect(res.text).not.toContain("#25 ");
    expect(res.text).toContain("use before=26");
    expect(res.text).toContain("[500 more chars]");
    const denied = await read.execute(ctx, { channel_id: "nope" });
    expect(denied.isError).toBe(true);
    const empty = await read.execute(ctx, { channel_id: "ch", before: 1 });
    expect(empty.text).toBe("No messages.");
  });

  test("pack declares guidance and is healthy", async () => {
    const pack = createCommunicationPack(fakeChat({}).port);
    expect(pack.guidance).toContain("send_message");
    expect(await pack.healthcheck()).toEqual({ available: true });
  });
});
