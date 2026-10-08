import { and, eq } from "drizzle-orm";
import { newId, type CreateWorkstation, type Terminal, type Workstation } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { LeaseService } from "../leases/lease-service.ts";
import { WorkstationError, type WorkstationBackend } from "./backend.ts";

export type WorkstationRow = typeof schema.workstations.$inferSelect;

export class WorkstationService {
  constructor(
    private readonly db: Db,
    readonly backend: WorkstationBackend,
    private readonly leases: LeaseService,
  ) {}

  list(orgId: string): Workstation[] {
    return this.db.select().from(schema.workstations).where(eq(schema.workstations.orgId, orgId)).orderBy(schema.workstations.name).all().map((r) => this.toWorkstation(r));
  }

  getRow(orgId: string, id: string): WorkstationRow {
    const row = this.db.select().from(schema.workstations).where(and(eq(schema.workstations.id, id), eq(schema.workstations.orgId, orgId))).get();
    if (!row) throw notFound("Workstation");
    return row;
  }

  get(orgId: string, id: string): Workstation {
    return this.toWorkstation(this.getRow(orgId, id));
  }

  /** Registers an OS user prepared by the setup script; it must answer a hive-exec probe first. */
  async create(user: AuthUser, input: CreateWorkstation, now = Date.now()): Promise<Workstation> {
    const clash = this.db.select({ id: schema.workstations.id }).from(schema.workstations).where(eq(schema.workstations.osUser, input.osUser)).get();
    if (clash) throw conflict(`${input.osUser} is already registered`);
    try {
      await this.backend.call(input.osUser, { op: "info" });
    } catch (error) {
      const reason = error instanceof WorkstationError ? error.message : String(error);
      throw badRequest(`${input.osUser} is not usable yet: ${reason}`);
    }
    const row: WorkstationRow = {
      id: newId("ws"), orgId: user.orgId, ownerUserId: user.id, name: input.name.trim(), kind: this.backend.kind,
      osUser: input.osUser, networkAllowed: true, createdAt: now, updatedAt: now,
    };
    this.db.insert(schema.workstations).values(row).run();
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "workstation.create", targetId: row.id, metadata: { osUser: row.osUser } }, now);
    return this.toWorkstation(row);
  }

  remove(user: AuthUser, id: string, now = Date.now()): void {
    this.getRow(user.orgId, id);
    this.db.delete(schema.workstations).where(eq(schema.workstations.id, id)).run();
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "workstation.delete", targetId: id }, now);
  }

  /** P2 binds each agent to at most one workstation. */
  bind(user: AuthUser, agentId: string, workstationId: string | null, now = Date.now()): void {
    if (workstationId) this.getRow(user.orgId, workstationId);
    this.db.transaction((tx) => {
      tx.delete(schema.agentWorkstations).where(eq(schema.agentWorkstations.agentId, agentId)).run();
      if (workstationId) tx.insert(schema.agentWorkstations).values({ agentId, workstationId, createdAt: now }).run();
    });
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "agent.bind_workstation", targetId: agentId, metadata: { workstationId } }, now);
  }

  forAgent(agentId: string): WorkstationRow | null {
    const row = this.db.select({ ws: schema.workstations }).from(schema.agentWorkstations)
      .innerJoin(schema.workstations, eq(schema.workstations.id, schema.agentWorkstations.workstationId))
      .where(eq(schema.agentWorkstations.agentId, agentId)).get();
    return row?.ws ?? null;
  }

  workstationIdOf(agentId: string): string | null {
    return this.db.select({ id: schema.agentWorkstations.workstationId }).from(schema.agentWorkstations).where(eq(schema.agentWorkstations.agentId, agentId)).get()?.id ?? null;
  }

  async terminals(row: WorkstationRow): Promise<Terminal[]> {
    const res = await this.backend.call<{ sessions: Terminal[] }>(row.osUser, { op: "tmux.list" });
    return res.sessions;
  }

  async readTerminal(row: WorkstationRow, name: string, lines = 200): Promise<string> {
    const res = await this.backend.call<{ output: string }>(row.osUser, { op: "tmux.read", name, lines });
    return res.output;
  }

  toWorkstation(row: WorkstationRow): Workstation {
    const agentIds = this.db.select({ id: schema.agentWorkstations.agentId }).from(schema.agentWorkstations)
      .where(eq(schema.agentWorkstations.workstationId, row.id)).all().map((r) => r.id);
    return {
      id: row.id, name: row.name, kind: row.kind, osUser: row.osUser, networkAllowed: row.networkAllowed,
      agentIds, writeLease: this.leases.current(row.id), createdAt: row.createdAt,
    };
  }
}
