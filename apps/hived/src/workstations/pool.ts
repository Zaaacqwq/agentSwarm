import { eq } from "drizzle-orm";
import type { WorkstationView } from "@hive/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { WorkstationBackend } from "./backend.ts";

type Row = typeof schema.workstations.$inferSelect;

/**
 * The pool of workstation users. A running run holds exactly one; its worktree lives there,
 * so follow-ups of the same run come back to the same workstation.
 */
export class WorkstationPool {
  private readonly db: Db;
  private readonly backend: WorkstationBackend;
  private readonly onChange: (ws: WorkstationView) => void;

  constructor(db: Db, backend: WorkstationBackend, onChange: (ws: WorkstationView) => void = () => {}) {
    this.db = db;
    this.backend = backend;
    this.onChange = onChange;
  }

  /** Registers the users that exist, drops the ones that are gone, and health-checks each. */
  async sync(now = Date.now()): Promise<WorkstationView[]> {
    const users = await this.backend.listUsers();
    const known = new Set(this.db.select({ id: schema.workstations.id }).from(schema.workstations).all().map((r) => r.id));
    for (const id of known) if (!users.includes(id)) this.db.delete(schema.workstations).where(eq(schema.workstations.id, id)).run();
    for (const id of users) {
      if (!known.has(id)) this.db.insert(schema.workstations).values({ id, status: "free", runId: null, lastCheckAt: null, lastError: null, updatedAt: now }).run();
    }
    // Leases do not survive a restart: no run is running yet.
    this.db.update(schema.workstations).set({ status: "free", runId: null }).where(eq(schema.workstations.status, "busy")).run();
    await Promise.all(users.map((id) => this.check(id)));
    return this.list();
  }

  async check(id: string, now = Date.now()): Promise<WorkstationView> {
    let error: string | null = null;
    try {
      const info = await this.backend.call<{ user: string; sandbox: boolean }>(id, { op: "info" }, { timeoutMs: 20_000 });
      if (info.user !== id) error = `ws-exec reports ${info.user}`;
      else if (!info.sandbox) error = "ws-exec runs without its sandbox";
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const row = this.row(id);
    const status = error ? "unhealthy" : row?.status === "busy" ? "busy" : "free";
    this.db.update(schema.workstations).set({ status, lastCheckAt: now, lastError: error, updatedAt: now }).where(eq(schema.workstations.id, id)).run();
    return this.emit(id);
  }

  list(): WorkstationView[] {
    return this.db.select().from(schema.workstations).all().sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))).map(view);
  }

  /** Takes `preferred` (a run's own workstation) or any free one; null when none is free. */
  acquire(runId: string, preferred: string | null, now = Date.now()): string | null {
    const id = this.db.transaction((tx) => {
      const free = tx.select().from(schema.workstations).where(eq(schema.workstations.status, "free")).all()
        .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
      const pick = preferred ? free.find((w) => w.id === preferred) : free[0];
      if (!pick) return null;
      tx.update(schema.workstations).set({ status: "busy", runId, updatedAt: now }).where(eq(schema.workstations.id, pick.id)).run();
      return pick.id;
    }, { behavior: "immediate" });
    if (id) this.emit(id);
    return id;
  }

  release(id: string, runId: string, now = Date.now()): void {
    const row = this.row(id);
    if (!row || row.runId !== runId) return;
    this.db.update(schema.workstations).set({ status: row.lastError ? "unhealthy" : "free", runId: null, updatedAt: now }).where(eq(schema.workstations.id, id)).run();
    this.emit(id);
  }

  private row(id: string): Row | undefined {
    return this.db.select().from(schema.workstations).where(eq(schema.workstations.id, id)).get();
  }

  private emit(id: string): WorkstationView {
    const v = view(this.row(id)!);
    this.onChange(v);
    return v;
  }
}

function view(row: Row): WorkstationView {
  return { id: row.id, status: row.status, runId: row.runId, lastCheckAt: row.lastCheckAt, lastError: row.lastError };
}
