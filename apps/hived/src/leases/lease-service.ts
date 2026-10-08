import { and, eq, isNull, lte } from "drizzle-orm";
import type { LeaseInfo } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";

export const WRITE_LEASE_TTL_MS = 10 * 60 * 1000;

type LeaseRow = typeof schema.leases.$inferSelect;

export type AcquireResult = { ok: true; lease: LeaseInfo } | { ok: false; holder: LeaseInfo };

/**
 * Exclusive, expiring leases on scarce resources ("one writer, many readers").
 * The partial unique index guarantees at most one live lease per resource.
 */
export class LeaseService {
  constructor(
    private readonly db: Db,
    private readonly onChange: (resourceId: string) => void = () => {},
  ) {}

  /** Acquires or renews. A holder renewing its own lease always succeeds. */
  acquire(input: { resourceId: string; agentId: string; runId: string | null; ttlMs?: number }, now = Date.now()): AcquireResult {
    const ttl = input.ttlMs ?? WRITE_LEASE_TTL_MS;
    const result = this.db.transaction((tx): AcquireResult => {
      tx.update(schema.leases).set({ releasedAt: now })
        .where(and(eq(schema.leases.resourceId, input.resourceId), isNull(schema.leases.releasedAt), lte(schema.leases.expiresAt, now))).run();
      const live = tx.select().from(schema.leases)
        .where(and(eq(schema.leases.kind, "workstation-write"), eq(schema.leases.resourceId, input.resourceId), isNull(schema.leases.releasedAt))).get();
      if (live && live.holderAgentId !== input.agentId) return { ok: false, holder: toInfo(live) };
      if (live) {
        const row = tx.update(schema.leases).set({ expiresAt: now + ttl, runId: input.runId ?? live.runId }).where(eq(schema.leases.id, live.id)).returning().get();
        return { ok: true, lease: toInfo(row!) };
      }
      const row = tx.insert(schema.leases).values({
        kind: "workstation-write", resourceId: input.resourceId, holderAgentId: input.agentId, runId: input.runId, acquiredAt: now, expiresAt: now + ttl,
      }).returning().get();
      return { ok: true, lease: toInfo(row) };
    });
    if (result.ok) this.onChange(input.resourceId);
    return result;
  }

  current(resourceId: string, now = Date.now()): LeaseInfo | null {
    const row = this.db.select().from(schema.leases)
      .where(and(eq(schema.leases.resourceId, resourceId), isNull(schema.leases.releasedAt))).get();
    return row && row.expiresAt > now ? toInfo(row) : null;
  }

  release(resourceId: string, agentId: string, now = Date.now()): boolean {
    const rows = this.db.update(schema.leases).set({ releasedAt: now })
      .where(and(eq(schema.leases.resourceId, resourceId), eq(schema.leases.holderAgentId, agentId), isNull(schema.leases.releasedAt))).returning().all();
    if (rows.length > 0) this.onChange(resourceId);
    return rows.length > 0;
  }

  /** Called when a run ends: its leases are returned so other agents can write. */
  releaseForRun(runId: string, now = Date.now()): void {
    const rows = this.db.update(schema.leases).set({ releasedAt: now })
      .where(and(eq(schema.leases.runId, runId), isNull(schema.leases.releasedAt))).returning().all();
    for (const r of rows) this.onChange(r.resourceId);
  }

  releaseAll(now = Date.now()): void {
    this.db.update(schema.leases).set({ releasedAt: now }).where(isNull(schema.leases.releasedAt)).run();
  }
}

function toInfo(row: LeaseRow): LeaseInfo {
  return { kind: row.kind, resourceId: row.resourceId, holderAgentId: row.holderAgentId, runId: row.runId, acquiredAt: row.acquiredAt, expiresAt: row.expiresAt };
}
