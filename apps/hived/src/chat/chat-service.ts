import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { newId, type AgentState, type Channel, type Message, type MessagePage } from "@hive/core";
import type { ChatPort, ChannelMessageView } from "@hive/tools";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import type { EventBus } from "../events/event-bus.ts";
import { forbidden, notFound } from "../http/errors.ts";

type MessageRow = typeof schema.messages.$inferSelect;

export interface ChatServiceDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly agentInOrg: (orgId: string, agentId: string) => boolean;
  readonly agentStateOf: (agentId: string) => AgentState;
  /** Called after a human message is stored, to wake the agents it addresses. */
  readonly onHumanMessage: (input: { orgId: string; channelId: string; messageId: number; agentIds: string[] }) => void;
}

export class ChatService implements ChatPort {
  constructor(private readonly deps: ChatServiceDeps) {}

  /** Returns the user's DM with an agent, creating it on first use. */
  openDm(user: AuthUser, agentId: string, now = Date.now()): Channel {
    if (!this.deps.agentInOrg(user.orgId, agentId)) throw notFound("Agent");
    const dmKey = `${user.id}:${agentId}`;
    const existing = this.deps.db.select().from(schema.channels).where(eq(schema.channels.dmKey, dmKey)).get();
    if (existing) return this.toChannel(existing.id, agentId, existing.createdAt);
    const id = newId("ch");
    this.deps.db.transaction((tx) => {
      tx.insert(schema.channels).values({ id, orgId: user.orgId, ownerUserId: user.id, kind: "dm", dmKey, createdAt: now }).run();
      tx.insert(schema.channelMembers).values([
        { channelId: id, memberKind: "user", memberId: user.id, joinedAt: now },
        { channelId: id, memberKind: "agent", memberId: agentId, joinedAt: now },
      ]).run();
    });
    return this.toChannel(id, agentId, now);
  }

  listChannels(user: AuthUser): Channel[] {
    const mine = this.deps.db
      .select({ id: schema.channels.id, createdAt: schema.channels.createdAt })
      .from(schema.channels)
      .innerJoin(schema.channelMembers, eq(schema.channelMembers.channelId, schema.channels.id))
      .where(and(eq(schema.channels.orgId, user.orgId), eq(schema.channelMembers.memberKind, "user"), eq(schema.channelMembers.memberId, user.id)))
      .all();
    if (mine.length === 0) return [];
    const agentsByChannel = new Map(
      this.deps.db.select({ channelId: schema.channelMembers.channelId, agentId: schema.channelMembers.memberId })
        .from(schema.channelMembers)
        .where(and(inArray(schema.channelMembers.channelId, mine.map((c) => c.id)), eq(schema.channelMembers.memberKind, "agent")))
        .all()
        .map((r) => [r.channelId, r.agentId]),
    );
    return mine
      .flatMap((c) => {
        const agentId = agentsByChannel.get(c.id);
        return agentId ? [this.toChannel(c.id, agentId, c.createdAt)] : [];
      })
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  }

  listMessages(user: AuthUser, channelId: string, opts: { before?: number; limit?: number }): MessagePage {
    this.assertUserMember(user, channelId);
    const limit = opts.limit ?? 50;
    const rows = this.page(channelId, opts.before, limit + 1);
    return { messages: rows.slice(-limit).map(toMessage), hasMore: rows.length > limit };
  }

  postUserMessage(user: AuthUser, channelId: string, body: string, now = Date.now()): Message {
    this.assertUserMember(user, channelId);
    const message = this.insertMessage({ channelId, authorKind: "user", authorId: user.id, body, runId: null, createdAt: now });
    this.deps.bus.publish(user.orgId, { type: "message.created", message });
    const agentIds = this.agentMembers(channelId);
    this.deps.onHumanMessage({ orgId: user.orgId, channelId, messageId: message.id, agentIds });
    return message;
  }

  postSystemMessage(orgId: string, channelId: string, body: string, runId: string | null, now = Date.now()): Message {
    const message = this.insertMessage({ channelId, authorKind: "system", authorId: "system", body, runId, createdAt: now });
    this.deps.bus.publish(orgId, { type: "message.created", message });
    return message;
  }

  getMessages(ids: readonly number[]): Message[] {
    if (ids.length === 0) return [];
    return this.deps.db.select().from(schema.messages).where(inArray(schema.messages.id, [...ids])).orderBy(schema.messages.id).all().map(toMessage);
  }

  authorName(kind: Message["authorKind"], id: string): string {
    if (kind === "system") return "system";
    if (kind === "user") return this.deps.db.select({ n: schema.users.username }).from(schema.users).where(eq(schema.users.id, id)).get()?.n ?? "user";
    return this.deps.db.select({ n: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, id)).get()?.n ?? "agent";
  }

  // ChatPort (agent-facing) -------------------------------------------------

  isMember(channelId: string, agentId: string): boolean {
    return !!this.deps.db.select({ c: schema.channelMembers.channelId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberKind, "agent"), eq(schema.channelMembers.memberId, agentId)))
      .get();
  }

  postAgentMessage(input: { channelId: string; agentId: string; runId: string; body: string }): { id: number } {
    const channel = this.deps.db.select({ orgId: schema.channels.orgId }).from(schema.channels).where(eq(schema.channels.id, input.channelId)).get();
    if (!channel || !this.isMember(input.channelId, input.agentId)) throw forbidden("Agent is not a member of this channel");
    const message = this.insertMessage({ channelId: input.channelId, authorKind: "agent", authorId: input.agentId, body: input.body, runId: input.runId, createdAt: Date.now() });
    this.deps.bus.publish(channel.orgId, { type: "message.created", message });
    return { id: message.id };
  }

  readChannel(channelId: string, opts: { before?: number; limit: number }): { messages: ChannelMessageView[]; hasMore: boolean } {
    const rows = this.page(channelId, opts.before, opts.limit + 1);
    const kept = rows.slice(-opts.limit);
    return {
      messages: kept.map((r) => ({ id: r.id, author: this.authorName(r.authorKind, r.authorId), authorKind: r.authorKind, body: r.body, createdAt: r.createdAt })),
      hasMore: rows.length > opts.limit,
    };
  }

  // -------------------------------------------------------------------------

  private page(channelId: string, before: number | undefined, take: number): MessageRow[] {
    const where = before !== undefined
      ? and(eq(schema.messages.channelId, channelId), lt(schema.messages.id, before))
      : eq(schema.messages.channelId, channelId);
    return this.deps.db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.id)).limit(take).all().reverse();
  }

  private insertMessage(values: Omit<MessageRow, "id">): Message {
    const row = this.deps.db.insert(schema.messages).values(values).returning().get();
    return toMessage(row);
  }

  private agentMembers(channelId: string): string[] {
    return this.deps.db.select({ id: schema.channelMembers.memberId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberKind, "agent")))
      .all()
      .map((r) => r.id);
  }

  private assertUserMember(user: AuthUser, channelId: string): void {
    const member = this.deps.db.select({ c: schema.channelMembers.channelId }).from(schema.channelMembers)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
      .where(and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberKind, "user"),
        eq(schema.channelMembers.memberId, user.id),
        eq(schema.channels.orgId, user.orgId),
      ))
      .get();
    if (!member) throw notFound("Channel");
  }

  private toChannel(id: string, agentId: string, createdAt: number): Channel {
    const last = this.deps.db.select().from(schema.messages).where(eq(schema.messages.channelId, id)).orderBy(desc(schema.messages.id)).limit(1).get();
    return { id, kind: "dm", agentId, lastMessage: last ? toMessage(last) : null, agentState: this.deps.agentStateOf(agentId), createdAt };
  }
}

function toMessage(row: MessageRow): Message {
  return { id: row.id, channelId: row.channelId, authorKind: row.authorKind, authorId: row.authorId, body: row.body, runId: row.runId, createdAt: row.createdAt };
}
