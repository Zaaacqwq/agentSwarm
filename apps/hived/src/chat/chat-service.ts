import { and, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { AgentState, Channel, Message, MessagePage, QueueInfo, ReactionSummary, SearchHit } from "@hive/core";
import type { AgentContext, ChatPort, ChatView, ChannelMessageView, ColleagueView } from "@hive/tools";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import type { EventBus } from "../events/event-bus.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import { ChannelStore, type ChannelRow } from "./channels.ts";
import { ChainStore } from "./chains.ts";
import { parseMentions } from "./mentions.ts";
import type { FileStore } from "../files/file-store.ts";

type MessageRow = typeof schema.messages.$inferSelect;

export const AGENT_MESSAGES_PER_HOUR = 60;
const BODY_PREVIEW = 1000;

export interface Delivery {
  readonly orgId: string;
  readonly agentId: string;
  readonly messageId: number;
  readonly fromAgent: boolean;
}

export interface ChatServiceDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly agentInOrg: (orgId: string, agentId: string) => boolean;
  readonly agentStateOf: (agentId: string) => AgentState;
  readonly agents: (orgId: string) => { id: string; name: string; role: string }[];
  /** Wakes an agent for a stored message. */
  readonly deliver: (delivery: Delivery) => void;
  /** Whether an agent can accept another agent-originated delivery right now (queue caps). */
  readonly canAcceptFromAgent: (agentId: string) => boolean;
  readonly queueOf?: (agentId: string) => QueueInfo | undefined;
  readonly files?: FileStore;
}

/** Messages, wake rules, publication policy, reactions and search. Implements the agent-facing ChatPort. */
export class ChatService implements ChatPort {
  readonly channels: ChannelStore;
  readonly chains: ChainStore;
  /** Per-run chain for publications that branch out of private human work. */
  private readonly branchChains = new Map<string, string>();

  constructor(private readonly deps: ChatServiceDeps) {
    this.channels = new ChannelStore(deps.db, deps.agentInOrg, (id) => this.agentName(id));
    this.chains = new ChainStore(deps.db);
  }

  // --- people ---------------------------------------------------------------

  openDm(user: AuthUser, agentId: string): Channel {
    return this.toChannel(this.channels.openDm(user, agentId));
  }

  listChannels(user: AuthUser): Channel[] {
    return this.channels.listForUser(user).map((c) => this.toChannel(c))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));
  }

  channel(user: AuthUser, channelId: string): Channel {
    return this.toChannel(this.channels.assertUserCanRead(user, channelId));
  }

  createGroup(user: AuthUser, title: string, agentIds: readonly string[]): Channel {
    const channel = this.toChannel(this.channels.createGroup(user, title, agentIds));
    this.deps.bus.publish(user.orgId, { type: "channel.updated", channel }, { channelId: channel.id });
    return channel;
  }

  updateGroup(user: AuthUser, channelId: string, input: { title?: string; agentIds?: readonly string[] }): Channel {
    const { row } = this.channels.updateGroup(user, channelId, input);
    const channel = this.toChannel(row);
    this.deps.bus.publish(user.orgId, { type: "channel.updated", channel }, { channelId: channel.id });
    return channel;
  }

  deleteGroup(user: AuthUser, channelId: string, hasPendingWork: (channelId: string) => boolean): void {
    if (hasPendingWork(channelId)) throw conflict("Agents are still working on messages from this group; stop them or wait, then retry");
    const userIds = this.channels.members(channelId).filter((m) => m.kind === "user").map((m) => m.id);
    this.channels.deleteGroup(user, channelId);
    this.deps.bus.publish(user.orgId, { type: "channel.deleted", channelId }, { userIds });
  }

  listMessages(user: AuthUser, channelId: string, opts: { before?: number; around?: number; limit?: number }): MessagePage {
    this.channels.assertUserCanRead(user, channelId);
    const limit = opts.limit ?? 50;
    if (opts.around !== undefined) {
      const newer = this.deps.db.select().from(schema.messages).where(and(eq(schema.messages.channelId, channelId), gte(schema.messages.id, opts.around)))
        .orderBy(schema.messages.id).limit(Math.ceil(limit / 2)).all();
      const half = Math.floor(limit / 2);
      const older = this.page(channelId, opts.around, half + 1);
      const hasMore = older.length > half;
      return { messages: [...older.slice(Math.max(0, older.length - half)), ...newer].map((r) => this.toMessage(r)), hasMore };
    }
    const rows = this.page(channelId, opts.before, limit + 1);
    return { messages: rows.slice(-limit).map((r) => this.toMessage(r)), hasMore: rows.length > limit };
  }

  postUserMessage(user: AuthUser, channelId: string, body: string, replyToId?: number, attachmentIds: readonly string[] = [], now = Date.now()): Message {
    const ch = this.channels.assertUserCanWrite(user, channelId);
    if (replyToId !== undefined) this.assertReplyTarget(channelId, replyToId);
    const mentions = this.mentionsIn(ch, body);
    const row = this.insert({ channelId, authorKind: "user", authorId: user.id, authorName: user.username, body, runId: null, replyToId: replyToId ?? null, chainId: null, mentions: mentions.ids, createdAt: now });
    try {
      this.deps.files?.bind(attachmentIds, row.id, channelId, { kind: "user", id: user.id });
    } catch (error) {
      this.deps.db.delete(schema.messages).where(eq(schema.messages.id, row.id)).run();
      throw error;
    }
    const chain = this.chains.start(user.orgId, "user", row.id, now);
    this.deps.db.update(schema.messages).set({ chainId: chain.id }).where(eq(schema.messages.id, row.id)).run();
    const message = { ...row, chainId: chain.id };
    const view = this.toMessage(message);
    this.deps.bus.publish(user.orgId, { type: "message.created", message: view }, { channelId });
    for (const agentId of this.recipients(ch, { kind: "user", id: user.id }, mentions)) {
      this.deps.deliver({ orgId: user.orgId, agentId, messageId: message.id, fromAgent: false });
    }
    return view;
  }

  postSystemMessage(orgId: string, channelId: string, body: string, runId: string | null, now = Date.now()): Message {
    const row = this.insert({ channelId, authorKind: "system", authorId: "system", authorName: "system", body, runId, replyToId: null, chainId: null, mentions: [], createdAt: now });
    const view = this.toMessage(row);
    this.deps.bus.publish(orgId, { type: "message.created", message: view }, { channelId });
    return view;
  }

  /**
   * A system notice that deliberately wakes specific agents (task assignment, review requests,
   * handoffs). It starts its own chain so the woken agents can publish.
   */
  postNotice(orgId: string, channelId: string, body: string, wake: readonly string[], origin: "user" | "agent", now = Date.now()): Message {
    const row = this.insert({ channelId, authorKind: "system", authorId: "system", authorName: "system", body, runId: null, replyToId: null, chainId: null, mentions: [...wake], createdAt: now });
    const chain = this.chains.start(orgId, origin, row.id, now);
    this.deps.db.update(schema.messages).set({ chainId: chain.id }).where(eq(schema.messages.id, row.id)).run();
    const view = this.toMessage({ ...row, chainId: chain.id });
    this.deps.bus.publish(orgId, { type: "message.created", message: view }, { channelId });
    for (const agentId of wake) {
      if (this.channels.isAgentMember(channelId, agentId)) this.deps.deliver({ orgId, agentId, messageId: row.id, fromAgent: origin === "agent" });
    }
    return view;
  }

  getMessages(ids: readonly number[]): Message[] {
    if (ids.length === 0) return [];
    return this.deps.db.select().from(schema.messages).where(inArray(schema.messages.id, [...ids])).orderBy(schema.messages.id).all().map((r) => this.toMessage(r));
  }

  channelRow(channelId: string): ChannelRow | null {
    return this.channels.get(channelId);
  }

  authorName(kind: Message["authorKind"], id: string): string {
    if (kind === "system") return "system";
    if (kind === "user") return this.deps.db.select({ n: schema.users.username }).from(schema.users).where(eq(schema.users.id, id)).get()?.n ?? "user";
    return this.agentName(id);
  }

  react(actor: { kind: "user" | "agent"; id: string; orgId: string }, messageId: number, emoji: string, add: boolean, now = Date.now()): Message {
    if (!isEmoji(emoji)) throw badRequest("Use a single emoji");
    const row = this.deps.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!row) throw notFound("Message");
    if (add) {
      this.deps.db.insert(schema.reactions).values({ messageId, actorKind: actor.kind, actorId: actor.id, emoji, createdAt: now }).onConflictDoNothing().run();
    } else {
      this.deps.db.delete(schema.reactions).where(and(eq(schema.reactions.messageId, messageId), eq(schema.reactions.actorKind, actor.kind), eq(schema.reactions.actorId, actor.id), eq(schema.reactions.emoji, emoji))).run();
    }
    const view = this.toMessage(row);
    this.deps.bus.publish(actor.orgId, { type: "message.updated", message: view }, { channelId: row.channelId });
    return view;
  }

  reactAsUser(user: AuthUser, messageId: number, emoji: string, add: boolean): Message {
    const row = this.deps.db.select({ channelId: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!row) throw notFound("Message");
    this.channels.assertUserCanWrite(user, row.channelId);
    return this.react({ kind: "user", id: user.id, orgId: user.orgId }, messageId, emoji, add);
  }

  /** Full-text search over channels the reader may see (trigram index, LIKE for short terms). */
  searchForUser(user: AuthUser, query: string, channelId?: string, limit = 25): SearchHit[] {
    const visible = channelId ? [this.channels.assertUserCanRead(user, channelId)] : this.channels.listForUser(user);
    return this.search(visible, query, limit).map((r) => {
      const ch = visible.find((c) => c.id === r.channelId)!;
      return { message: this.toMessage(r), channelKind: ch.kind, channelTitle: this.channels.title(ch) };
    });
  }

  // --- agents (ChatPort) ------------------------------------------------------

  isMember(channelId: string, agentId: string): boolean {
    return this.channels.isAgentMember(channelId, agentId);
  }

  listChats(ctx: AgentContext): ChatView[] {
    return this.channels.listForAgent(ctx.agentId).map((ch) => ({
      channelId: ch.id,
      kind: ch.kind,
      title: this.channels.title(ch),
      members: this.channels.members(ch.id).map((m) => (m.kind === "user" ? this.authorName("user", m.id) : this.agentName(m.id))),
      canSend: ch.kind !== "dm" || (ctx.trigger?.humanChannelIds.includes(ch.id) ?? false),
    }));
  }

  send(ctx: AgentContext, input: { channelId: string; body: string; replyToId?: number; attachmentIds?: readonly string[] }, now = Date.now()): { id: number } {
    const ch = this.channels.get(input.channelId);
    if (!ch || !this.channels.isAgentMember(ch.id, ctx.agentId)) throw new Error(`You are not a member of channel ${input.channelId}.`);
    if (ch.kind === "dm" && !(ctx.trigger?.humanChannelIds.includes(ch.id) ?? false)) {
      throw new Error("You can only post in your owner's private chat when they messaged you there in this turn.");
    }
    if (input.replyToId !== undefined) this.assertReplyTarget(ch.id, input.replyToId);
    if (this.recentAgentMessages(ctx.agentId, now) >= AGENT_MESSAGES_PER_HOUR) {
      throw new Error(`Rate limit: you have sent ${AGENT_MESSAGES_PER_HOUR} messages in the last hour. Wait before sending more.`);
    }
    const mentions = this.mentionsIn(ch, input.body);
    const recipients = this.recipients(ch, { kind: "agent", id: ctx.agentId }, mentions);
    const busy = recipients.filter((id) => !this.deps.canAcceptFromAgent(id));
    if (busy.length) throw new Error(`${busy.map((id) => this.agentName(id)).join(", ")} has too many pending messages; try again later.`);

    const chainId = this.chainForPublication(ctx, ch, now);
    const charge = this.chains.charge(chainId, now);
    if (!charge.ok) {
      if (charge.justPaused) {
        this.postSystemMessage(ch.orgId, ch.id, `Agents paused after ${charge.chain.budget} messages in this conversation. Reply to continue.`, ctx.runId);
      }
      throw new Error("This conversation is paused until a person replies. Do not send more messages now.");
    }
    const row = this.insert({
      channelId: ch.id, authorKind: "agent", authorId: ctx.agentId, authorName: this.agentName(ctx.agentId), body: input.body,
      runId: ctx.runId, replyToId: input.replyToId ?? null, chainId, mentions: mentions.ids, createdAt: now,
    });
    if (input.attachmentIds?.length) this.deps.files?.bind(input.attachmentIds, row.id, ch.id, { kind: "agent", id: ctx.agentId });
    this.deps.bus.publish(ch.orgId, { type: "message.created", message: this.toMessage(row) }, { channelId: ch.id });
    for (const agentId of recipients) this.deps.deliver({ orgId: ch.orgId, agentId, messageId: row.id, fromAgent: true });
    return { id: row.id };
  }

  /** Back-compat for P1 callers: posts as the agent with the run's policy. */
  postAgentMessage(input: { channelId: string; agentId: string; runId: string; body: string }, ctx?: AgentContext): { id: number } {
    return this.send(ctx ?? { agentId: input.agentId, orgId: "", runId: input.runId, grants: [], currentGrants: () => [] }, { channelId: input.channelId, body: input.body });
  }

  read(ctx: AgentContext, channelId: string, opts: { before?: number; limit: number }): { messages: ChannelMessageView[]; hasMore: boolean } {
    if (!this.channels.isAgentMember(channelId, ctx.agentId)) throw new Error(`You are not a member of channel ${channelId}.`);
    return this.readChannel(channelId, opts);
  }

  readChannel(channelId: string, opts: { before?: number; limit: number }): { messages: ChannelMessageView[]; hasMore: boolean } {
    const rows = this.page(channelId, opts.before, opts.limit + 1);
    return { messages: rows.slice(-opts.limit).map((r) => this.toView(r)), hasMore: rows.length > opts.limit };
  }

  searchFor(ctx: AgentContext, query: string, channelId?: string): (ChannelMessageView & { channel: string })[] {
    const mine = this.channels.listForAgent(ctx.agentId);
    const scope = channelId ? mine.filter((c) => c.id === channelId) : mine;
    if (channelId && scope.length === 0) throw new Error(`You are not a member of channel ${channelId}.`);
    return this.search(scope, query, 20).map((r) => ({ ...this.toView(r), channel: `${this.channels.title(scope.find((c) => c.id === r.channelId)!)} (${r.channelId})` }));
  }

  reactAsAgent(ctx: AgentContext, messageId: number, emoji: string): void {
    const row = this.deps.db.select({ channelId: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!row || !this.channels.isAgentMember(row.channelId, ctx.agentId)) throw new Error(`Message ${messageId} is not in a channel you belong to.`);
    const ch = this.channels.get(row.channelId)!;
    this.react({ kind: "agent", id: ctx.agentId, orgId: ch.orgId }, messageId, emoji, true);
  }

  readFile(ctx: AgentContext, fileId: string): { filename: string; text: string; truncated: boolean } {
    const file = this.deps.files?.get(fileId);
    if (!file || !this.channels.isAgentMember(file.channelId, ctx.agentId)) throw new Error(`No file ${fileId} in your channels.`);
    return this.deps.files!.readText(fileId);
  }

  /** Stores a file an agent produced and posts it in a channel (subject to the normal send policy). */
  attachAsAgent(ctx: AgentContext, channelId: string, filename: string, bytes: Uint8Array, caption: string): { id: number } {
    if (!this.deps.files) throw new Error("Files are not available");
    const ch = this.channels.get(channelId);
    if (!ch || !this.channels.isAgentMember(channelId, ctx.agentId)) throw new Error(`You are not a member of channel ${channelId}.`);
    const file = this.deps.files.save({ kind: "agent", id: ctx.agentId, orgId: ch.orgId }, channelId, filename, bytes);
    return this.send(ctx, { channelId, body: caption || `📎 ${file.filename}`, attachmentIds: [file.id] });
  }

  directory(ctx: AgentContext): ColleagueView[] {
    return this.deps.agents(ctx.orgId).filter((a) => a.id !== ctx.agentId).map((a) => ({ id: a.id, name: a.name, role: a.role }));
  }

  messageAgent(ctx: AgentContext, target: string, body: string): { channelId: string; id: number } {
    const colleagues = this.deps.agents(ctx.orgId);
    const peer = colleagues.find((a) => a.id === target) ?? colleagues.find((a) => a.name.toLowerCase() === target.trim().toLowerCase());
    if (!peer || peer.id === ctx.agentId) throw new Error(`No colleague named ${target}. Use agent_directory to see who you can message.`);
    const owner = this.deps.db.select({ u: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get()?.u;
    if (!owner) throw new Error("Agent not found");
    const existed = this.channels.findByKey([ctx.agentId, peer.id].sort().join(":"));
    const ch = existed ?? this.channels.openAgentDm(ctx.orgId, owner, ctx.agentId, peer.id);
    let id: number;
    try {
      ({ id } = this.send(ctx, { channelId: ch.id, body }));
    } catch (error) {
      // Do not leave an empty, org-visible channel behind when policy refuses the first message.
      if (!existed) this.channels.remove(ch.id);
      throw error;
    }
    if (!existed) this.deps.bus.publish(ctx.orgId, { type: "channel.updated", channel: this.toChannel(ch) }, { channelId: ch.id });
    return { channelId: ch.id, id };
  }

  /** Drops per-run state once a run has settled. */
  forgetRun(runId: string): void {
    this.branchChains.delete(runId);
  }

  // --- internals ----------------------------------------------------------------

  /**
   * Publications inherit the run's chain, except when private human work (a person's DM) branches
   * out to other agents: that branch gets its own smaller agent chain, shared for the run.
   */
  private chainForPublication(ctx: AgentContext, target: ChannelRow, now: number): string {
    const chainId = ctx.trigger?.chainId ?? null;
    const chain = chainId ? this.chains.get(chainId) : null;
    if (chain) {
      const originChannel = chain.originMessageId
        ? this.deps.db.select({ c: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, chain.originMessageId)).get()?.c
        : undefined;
      const origin = originChannel ? this.channels.get(originChannel) : null;
      const branchesOut = chain.originKind === "user" && origin?.kind === "dm" && target.id !== origin.id;
      if (!branchesOut) return chain.id;
    }
    const existing = this.branchChains.get(ctx.runId);
    if (existing) return existing;
    const created = this.chains.start(target.orgId, "agent", null, now);
    this.branchChains.set(ctx.runId, created.id);
    return created.id;
  }

  /** Who wakes: DM -> the agent; agent DM -> the other agent; group -> mentioned agents (or all). */
  private recipients(ch: ChannelRow, author: { kind: "user" | "agent"; id: string }, mentions: { ids: string[]; all: boolean }): string[] {
    const agents = this.channels.agentMembers(ch.id).filter((id) => !(author.kind === "agent" && id === author.id));
    if (ch.kind === "dm") return author.kind === "user" ? agents : [];
    if (ch.kind === "agent_dm") return agents;
    // Groups and task channels: only mentioned agents wake.
    return mentions.all ? agents : agents.filter((id) => mentions.ids.includes(id));
  }

  private mentionsIn(ch: ChannelRow, body: string): { ids: string[]; all: boolean } {
    if (ch.kind !== "group" && ch.kind !== "task") return { ids: [], all: false };
    const candidates = this.channels.agentMembers(ch.id).map((id) => ({ id, name: this.agentName(id) }));
    return parseMentions(body, candidates);
  }

  private recentAgentMessages(agentId: string, now: number): number {
    return this.deps.db.select({ n: sql<number>`count(*)` }).from(schema.messages)
      .where(and(eq(schema.messages.authorKind, "agent"), eq(schema.messages.authorId, agentId), gt(schema.messages.createdAt, now - 3_600_000))).get()?.n ?? 0;
  }

  private assertReplyTarget(channelId: string, replyToId: number): void {
    const target = this.deps.db.select({ c: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, replyToId)).get();
    if (!target || target.c !== channelId) throw badRequest("Can only reply to a message in the same channel");
  }

  private search(channels: readonly ChannelRow[], query: string, limit: number): MessageRow[] {
    if (channels.length === 0) return [];
    const ids = channels.map((c) => c.id);
    const terms = (query.match(/"[^"]+"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, "")).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const conditions = [inArray(schema.messages.channelId, ids)];
    if (long.length) {
      const match = long.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
      conditions.push(sql`${schema.messages.id} in (select rowid from messages_fts where messages_fts match ${match})`);
    }
    for (const t of short) conditions.push(sql`lower(${schema.messages.body}) like ${`%${t.toLowerCase().replace(/[%_]/g, "")}%`}`);
    return this.deps.db.select().from(schema.messages).where(and(...conditions)).orderBy(desc(schema.messages.id)).limit(limit).all();
  }

  private page(channelId: string, before: number | undefined, take: number): MessageRow[] {
    const where = before !== undefined ? and(eq(schema.messages.channelId, channelId), lt(schema.messages.id, before)) : eq(schema.messages.channelId, channelId);
    return this.deps.db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.id)).limit(take).all().reverse();
  }

  private insert(values: Omit<MessageRow, "id">): MessageRow {
    return this.deps.db.insert(schema.messages).values(values).returning().get();
  }

  private agentName(id: string): string {
    return this.deps.db.select({ n: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, id)).get()?.n ?? "agent";
  }

  private reactionsOf(messageIds: readonly number[]): Map<number, ReactionSummary[]> {
    const out = new Map<number, ReactionSummary[]>();
    if (messageIds.length === 0) return out;
    const rows = this.deps.db.select().from(schema.reactions).where(inArray(schema.reactions.messageId, [...messageIds])).orderBy(schema.reactions.createdAt).all();
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      const entry = list.find((e) => e.emoji === r.emoji);
      const actor = { kind: r.actorKind, id: r.actorId };
      if (entry) entry.actors.push(actor);
      else list.push({ emoji: r.emoji, actors: [actor] });
      out.set(r.messageId, list);
    }
    return out;
  }

  toMessage(row: MessageRow): Message {
    return {
      id: row.id, channelId: row.channelId, authorKind: row.authorKind, authorId: row.authorId, authorName: row.authorName,
      body: row.body, runId: row.runId, replyToId: row.replyToId, chainId: row.chainId, mentions: row.mentions,
      reactions: this.reactionsOf([row.id]).get(row.id) ?? [], attachments: this.attachmentsOf(row.id), createdAt: row.createdAt,
    };
  }

  private attachmentsOf(messageId: number): Message["attachments"] {
    return this.deps.db.select({ id: schema.attachments.id, filename: schema.attachments.filename, mime: schema.attachments.mime, size: schema.attachments.size })
      .from(schema.attachments).where(eq(schema.attachments.messageId, messageId)).all();
  }

  private toView(row: MessageRow): ChannelMessageView {
    const reactions = this.reactionsOf([row.id]).get(row.id) ?? [];
    const body = row.body.length <= BODY_PREVIEW ? row.body : `${row.body.slice(0, BODY_PREVIEW)}… [${row.body.length - BODY_PREVIEW} more chars]`;
    return {
      id: row.id, author: row.authorName || this.authorName(row.authorKind, row.authorId), authorKind: row.authorKind, body,
      replyToId: row.replyToId, reactions: reactions.map((r) => `${r.emoji}×${r.actors.length}`),
      attachments: this.attachmentsOf(row.id).map((a) => `${a.filename} (${a.id}, ${Math.max(1, Math.round(a.size / 1024))} KB)`), createdAt: row.createdAt,
    };
  }

  toChannel(row: ChannelRow): Channel {
    const last = this.deps.db.select().from(schema.messages).where(eq(schema.messages.channelId, row.id)).orderBy(desc(schema.messages.id)).limit(1).get();
    const members = this.channels.members(row.id);
    const agentId = row.kind === "dm" ? (members.find((m) => m.kind === "agent")?.id ?? null) : null;
    return {
      id: row.id, kind: row.kind, title: row.kind === "group" || row.kind === "task" ? row.title : this.channels.title(row), members, agentId,
      lastMessage: last ? this.toMessage(last) : null,
      agentState: agentId ? this.deps.agentStateOf(agentId) : "idle",
      createdAt: row.createdAt,
    };
  }
}

/** One emoji grapheme (including ZWJ sequences and skin tones). */
export function isEmoji(text: string): boolean {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
}
