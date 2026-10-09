import { and, eq, inArray } from "drizzle-orm";
import { newId, type Actor } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, conflict, forbidden, notFound } from "../http/errors.ts";

export type ChannelRow = typeof schema.channels.$inferSelect;

export const MAX_GROUP_AGENTS = 16;

/** Channel records, membership and the read/write rules for people and agents. */
export class ChannelStore {
  constructor(
    private readonly db: Db,
    private readonly agentInOrg: (orgId: string, agentId: string) => boolean,
    private readonly agentName: (agentId: string) => string,
  ) {}

  get(channelId: string): ChannelRow | null {
    return this.db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get() ?? null;
  }

  findByKey(dmKey: string): ChannelRow | null {
    return this.db.select().from(schema.channels).where(eq(schema.channels.dmKey, dmKey)).get() ?? null;
  }

  remove(channelId: string): void {
    this.db.delete(schema.channels).where(eq(schema.channels.id, channelId)).run();
  }

  members(channelId: string): Actor[] {
    return this.db.select({ kind: schema.channelMembers.memberKind, id: schema.channelMembers.memberId })
      .from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId)).all();
  }

  agentMembers(channelId: string): string[] {
    return this.members(channelId).filter((m) => m.kind === "agent").map((m) => m.id);
  }

  isAgentMember(channelId: string, agentId: string): boolean {
    return this.isMember(channelId, "agent", agentId);
  }

  isMember(channelId: string, kind: "user" | "agent", id: string): boolean {
    return !!this.db.select({ c: schema.channelMembers.channelId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberKind, kind), eq(schema.channelMembers.memberId, id))).get();
  }

  /** People read their own DMs and groups, and any agent-to-agent DM in their org. */
  assertUserCanRead(user: AuthUser, channelId: string): ChannelRow {
    const ch = this.get(channelId);
    if (!ch || ch.orgId !== user.orgId) throw notFound("Channel");
    if (ch.kind === "agent_dm" || this.isMember(ch.id, "user", user.id)) return ch;
    throw notFound("Channel");
  }

  /** People never speak inside agent-to-agent DMs. */
  assertUserCanWrite(user: AuthUser, channelId: string): ChannelRow {
    const ch = this.assertUserCanRead(user, channelId);
    if (ch.kind === "agent_dm") throw forbidden("Agent-to-agent conversations are read-only for people");
    return ch;
  }

  listForUser(user: AuthUser): ChannelRow[] {
    const mine = this.db.select({ ch: schema.channels }).from(schema.channels)
      .innerJoin(schema.channelMembers, eq(schema.channelMembers.channelId, schema.channels.id))
      .where(and(eq(schema.channels.orgId, user.orgId), eq(schema.channelMembers.memberKind, "user"), eq(schema.channelMembers.memberId, user.id)))
      .all().map((r) => r.ch);
    const agentDms = this.db.select().from(schema.channels).where(and(eq(schema.channels.orgId, user.orgId), eq(schema.channels.kind, "agent_dm"))).all();
    return [...mine, ...agentDms];
  }

  listForAgent(agentId: string): ChannelRow[] {
    return this.db.select({ ch: schema.channels }).from(schema.channels)
      .innerJoin(schema.channelMembers, eq(schema.channelMembers.channelId, schema.channels.id))
      .where(and(eq(schema.channelMembers.memberKind, "agent"), eq(schema.channelMembers.memberId, agentId))).all().map((r) => r.ch);
  }

  openDm(user: AuthUser, agentId: string, now = Date.now()): ChannelRow {
    if (!this.agentInOrg(user.orgId, agentId)) throw notFound("Agent");
    return this.findOrCreate(`${user.id}:${agentId}`, () => ({
      row: { id: newId("ch"), orgId: user.orgId, ownerUserId: user.id, kind: "dm", title: null, dmKey: `${user.id}:${agentId}`, createdAt: now },
      members: [{ kind: "user", id: user.id }, { kind: "agent", id: agentId }],
    }), now);
  }

  /** One channel per pair of agents, created on first message. */
  openAgentDm(orgId: string, ownerUserId: string, a: string, b: string, now = Date.now()): ChannelRow {
    if (a === b) throw badRequest("An agent cannot message itself");
    const key = [a, b].sort().join(":");
    return this.findOrCreate(key, () => ({
      row: { id: newId("ch"), orgId, ownerUserId, kind: "agent_dm", title: null, dmKey: key, createdAt: now },
      members: [{ kind: "agent", id: a }, { kind: "agent", id: b }],
    }), now);
  }

  createGroup(user: AuthUser, title: string, agentIds: readonly string[], now = Date.now()): ChannelRow {
    const agents = this.validAgents(user, agentIds);
    const row: ChannelRow = { id: newId("ch"), orgId: user.orgId, ownerUserId: user.id, kind: "group", title: title.trim(), dmKey: null, createdAt: now };
    this.db.transaction((tx) => {
      tx.insert(schema.channels).values(row).run();
      tx.insert(schema.channelMembers).values([
        { channelId: row.id, memberKind: "user", memberId: user.id, joinedAt: now },
        ...agents.map((id) => ({ channelId: row.id, memberKind: "agent" as const, memberId: id, joinedAt: now })),
      ]).run();
    });
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "group.create", targetId: row.id, metadata: { agents: agents.length } }, now);
    return row;
  }

  updateGroup(user: AuthUser, channelId: string, input: { title?: string; agentIds?: readonly string[] }, now = Date.now()): { row: ChannelRow; removed: string[] } {
    const ch = this.assertGroupOwner(user, channelId);
    const before = this.agentMembers(channelId);
    const next = input.agentIds ? this.validAgents(user, input.agentIds) : before;
    const removed = before.filter((id) => !next.includes(id));
    const added = next.filter((id) => !before.includes(id));
    this.db.transaction((tx) => {
      if (input.title) tx.update(schema.channels).set({ title: input.title.trim() }).where(eq(schema.channels.id, channelId)).run();
      if (removed.length) {
        tx.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberKind, "agent"), inArray(schema.channelMembers.memberId, removed))).run();
      }
      if (added.length) {
        tx.insert(schema.channelMembers).values(added.map((id) => ({ channelId, memberKind: "agent" as const, memberId: id, joinedAt: now }))).run();
      }
    });
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "group.update", targetId: channelId, metadata: { added: added.length, removed: removed.length, renamed: !!input.title } }, now);
    return { row: { ...ch, title: input.title?.trim() ?? ch.title }, removed };
  }

  deleteGroup(user: AuthUser, channelId: string, now = Date.now()): void {
    this.assertGroupOwner(user, channelId);
    this.db.delete(schema.channels).where(eq(schema.channels.id, channelId)).run();
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "group.delete", targetId: channelId }, now);
  }

  /** Display title: group name, the agent's name for a DM, "A ↔ B" for an agent DM. */
  title(row: ChannelRow): string {
    if (row.kind === "group") return row.title ?? "Group";
    const agents = this.agentMembers(row.id).map((id) => this.agentName(id));
    return row.kind === "dm" ? (agents[0] ?? "Direct message") : agents.join(" ↔ ");
  }

  private assertGroupOwner(user: AuthUser, channelId: string): ChannelRow {
    const ch = this.get(channelId);
    if (!ch || ch.orgId !== user.orgId || ch.kind !== "group" || !this.isMember(ch.id, "user", user.id)) throw notFound("Group");
    return ch;
  }

  private validAgents(user: AuthUser, agentIds: readonly string[]): string[] {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0 || unique.length > MAX_GROUP_AGENTS) throw badRequest(`A group needs 1-${MAX_GROUP_AGENTS} agents`);
    const missing = unique.filter((id) => !this.agentInOrg(user.orgId, id));
    if (missing.length) throw badRequest("Unknown agent in group");
    return unique;
  }

  private findOrCreate(key: string, build: () => { row: ChannelRow; members: Actor[] }, now: number): ChannelRow {
    const existing = this.db.select().from(schema.channels).where(eq(schema.channels.dmKey, key)).get();
    if (existing) return existing;
    const { row, members } = build();
    try {
      this.db.transaction((tx) => {
        tx.insert(schema.channels).values(row).run();
        tx.insert(schema.channelMembers).values(members.map((m) => ({ channelId: row.id, memberKind: m.kind, memberId: m.id, joinedAt: now }))).run();
      });
    } catch (error) {
      const raced = this.db.select().from(schema.channels).where(eq(schema.channels.dmKey, key)).get();
      if (raced) return raced;
      throw conflict(`Could not open channel: ${(error as Error).message}`);
    }
    return row;
  }
}
