import { and, eq } from "drizzle-orm";
import { newId, type Agent, type AgentState, type CreateAgent, type ToolGrant, type UpdateAgent } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";

export type AgentRow = typeof schema.agents.$inferSelect;

export interface AgentServiceDeps {
  readonly db: Db;
  readonly endpointExists: (orgId: string, endpointId: string) => boolean;
  readonly toolpackExists: (toolpackId: string) => boolean;
  readonly stateOf: (agentId: string) => AgentState;
  readonly workstationOf?: (agentId: string) => string | null;
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  list(user: AuthUser): Agent[] {
    const rows = this.deps.db.select().from(schema.agents).where(eq(schema.agents.orgId, user.orgId)).orderBy(schema.agents.createdAt).all();
    return rows.map((r) => this.toAgent(r));
  }

  get(user: AuthUser, id: string): Agent {
    return this.toAgent(this.getRow(user.orgId, id));
  }

  getRow(orgId: string, id: string): AgentRow {
    const row = this.deps.db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.orgId, orgId))).get();
    if (!row) throw notFound("Agent");
    return row;
  }

  exists(orgId: string, id: string): boolean {
    return !!this.deps.db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.orgId, orgId))).get();
  }

  findRow(id: string): AgentRow | null {
    return this.deps.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get() ?? null;
  }

  /** Grants as stored now; tools read this at execution time. */
  grantsOf(agentId: string): ToolGrant[] {
    return this.deps.db
      .select({ toolpackId: schema.agentToolGrants.toolpackId, toolName: schema.agentToolGrants.toolName })
      .from(schema.agentToolGrants)
      .where(eq(schema.agentToolGrants.agentId, agentId))
      .all();
  }

  create(user: AuthUser, input: CreateAgent, now = Date.now()): Agent {
    this.assertEndpoint(user.orgId, input.endpointId);
    const grants = this.validateGrants(input.grants ?? []);
    const row: AgentRow = {
      id: newId("agt"),
      orgId: user.orgId,
      ownerUserId: user.id,
      name: input.name.trim(),
      role: input.role.trim(),
      instructions: input.instructions,
      endpointId: input.endpointId,
      modelId: input.modelId.trim(),
      thinkingLevel: input.thinkingLevel,
      avatarSeed: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.transaction((tx) => {
      this.assertNameFree(tx, user.orgId, row.name);
      tx.insert(schema.agents).values(row).run();
      replaceGrants(tx, row.id, grants, now);
    });
    writeAudit(this.deps.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "agent.create", targetId: row.id, metadata: { grants: grantKeys(grants) } }, now);
    return this.toAgent(row);
  }

  update(user: AuthUser, id: string, input: UpdateAgent, now = Date.now()): Agent {
    const current = this.getRow(user.orgId, id);
    if (input.endpointId !== undefined) this.assertEndpoint(user.orgId, input.endpointId);
    const grants = input.grants !== undefined ? this.validateGrants(input.grants) : undefined;
    const next: AgentRow = {
      ...current,
      name: input.name?.trim() ?? current.name,
      role: input.role?.trim() ?? current.role,
      instructions: input.instructions ?? current.instructions,
      endpointId: input.endpointId ?? current.endpointId,
      modelId: input.modelId?.trim() ?? current.modelId,
      thinkingLevel: input.thinkingLevel ?? current.thinkingLevel,
      updatedAt: now,
    };
    this.deps.db.transaction((tx) => {
      if (next.name !== current.name) this.assertNameFree(tx, user.orgId, next.name);
      tx.update(schema.agents).set(next).where(eq(schema.agents.id, id)).run();
      if (grants) replaceGrants(tx, id, grants, now);
    });
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateAgent] !== undefined);
    writeAudit(this.deps.db, {
      orgId: user.orgId, actorKind: "user", actorId: user.id, action: "agent.update", targetId: id,
      metadata: grants ? { fields, grants: grantKeys(grants) } : { fields },
    }, now);
    return this.toAgent(next);
  }

  remove(user: AuthUser, id: string, now = Date.now()): void {
    this.getRow(user.orgId, id);
    this.deps.db.transaction((tx) => {
      // DM channels with a deleted agent have no counterpart left.
      const dmIds = tx.select({ id: schema.channelMembers.channelId }).from(schema.channelMembers)
        .where(and(eq(schema.channelMembers.memberKind, "agent"), eq(schema.channelMembers.memberId, id))).all();
      for (const { id: channelId } of dmIds) tx.delete(schema.channels).where(eq(schema.channels.id, channelId)).run();
      tx.delete(schema.agents).where(eq(schema.agents.id, id)).run();
    });
    writeAudit(this.deps.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "agent.delete", targetId: id }, now);
  }

  toAgent(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      instructions: row.instructions,
      endpointId: row.endpointId,
      modelId: row.modelId,
      thinkingLevel: row.thinkingLevel,
      avatarSeed: row.avatarSeed,
      grants: this.grantsOf(row.id),
      workstationId: this.deps.workstationOf?.(row.id) ?? null,
      state: this.deps.stateOf(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private assertEndpoint(orgId: string, endpointId: string): void {
    if (!this.deps.endpointExists(orgId, endpointId)) throw badRequest("Unknown endpoint");
  }

  private validateGrants(grants: readonly ToolGrant[]): ToolGrant[] {
    const unknown = grants.filter((g) => !this.deps.toolpackExists(g.toolpackId));
    if (unknown.length > 0) throw badRequest(`Unknown toolpack: ${unknown.map((g) => g.toolpackId).join(", ")}`);
    const seen = new Set<string>();
    return grants.filter((g) => {
      const key = `${g.toolpackId}/${g.toolName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private assertNameFree(tx: Pick<Db, "select">, orgId: string, name: string): void {
    const clash = tx.select({ id: schema.agents.id }).from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.name, name))).get();
    if (clash) throw conflict(`An agent named "${name}" already exists`);
  }
}

function replaceGrants(tx: Pick<Db, "delete" | "insert">, agentId: string, grants: readonly ToolGrant[], now: number): void {
  tx.delete(schema.agentToolGrants).where(eq(schema.agentToolGrants.agentId, agentId)).run();
  if (grants.length === 0) return;
  tx.insert(schema.agentToolGrants).values(grants.map((g) => ({ agentId, toolpackId: g.toolpackId, toolName: g.toolName, createdAt: now }))).run();
}

function grantKeys(grants: readonly ToolGrant[]): string[] {
  return grants.map((g) => `${g.toolpackId}/${g.toolName}`);
}
