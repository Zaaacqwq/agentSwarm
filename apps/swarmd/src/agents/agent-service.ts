import { and, desc, eq } from "drizzle-orm";
import type { AgentView, CreateAgent } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { badRequest, notFound } from "../errors.ts";

export type AgentRow = typeof schema.agents.$inferSelect;

export class AgentService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The standing agents; sub-agents only show inside their run trees. */
  list(projectId?: string): AgentView[] {
    const standing = eq(schema.agents.ephemeral, false);
    return this.db.select().from(schema.agents).where(projectId ? and(standing, eq(schema.agents.projectId, projectId)) : standing)
      .orderBy(desc(schema.agents.createdAt)).limit(200).all().map(view);
  }

  /** A one-run agent spawned by another agent: same project, the parent's endpoint unless told otherwise. */
  createEphemeral(parent: AgentRow, input: { name: string; role: string; modelId?: string }, now = Date.now()): AgentRow {
    const row: AgentRow = {
      id: newId("agt"), name: input.name, projectId: parent.projectId, role: input.role, endpointId: parent.endpointId,
      modelId: input.modelId ?? parent.modelId, instructions: "", runtime: "native", parentId: parent.id, depth: parent.depth + 1,
      budgetUsd: null, ephemeral: true, createdAt: now,
    };
    this.db.insert(schema.agents).values(row).run();
    return row;
  }

  get(id: string): AgentRow {
    const row = this.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    if (!row) throw notFound("No such agent");
    return row;
  }

  view(id: string): AgentView {
    return view(this.get(id));
  }

  create(actor: string, input: CreateAgent, now = Date.now()): AgentView {
    if (!this.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, input.projectId)).get()) throw badRequest("No such project");
    if (!this.db.select({ id: schema.endpoints.id }).from(schema.endpoints).where(eq(schema.endpoints.id, input.endpointId)).get()) throw badRequest("No such endpoint");
    const row: AgentRow = {
      id: newId("agt"), name: input.name.trim(), projectId: input.projectId, role: input.role.trim(), endpointId: input.endpointId,
      modelId: input.modelId, instructions: input.instructions ?? "", runtime: "native", parentId: null, depth: 0, budgetUsd: null, ephemeral: false, createdAt: now,
    };
    this.db.insert(schema.agents).values(row).run();
    audit(this.db, actor, "agent.create", row.id, { name: row.name, model: row.modelId }, now);
    return view(row);
  }
}

function view(row: AgentRow): AgentView {
  return {
    id: row.id, name: row.name, projectId: row.projectId, role: row.role, endpointId: row.endpointId, modelId: row.modelId,
    instructions: row.instructions, runtime: row.runtime, parentId: row.parentId, ephemeral: row.ephemeral, createdAt: row.createdAt,
  };
}
