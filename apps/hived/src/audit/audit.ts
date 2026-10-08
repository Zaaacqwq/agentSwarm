import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";

export interface AuditEntry {
  readonly orgId: string | null;
  readonly actorKind: "user" | "agent" | "system";
  readonly actorId: string | null;
  readonly action: string;
  readonly targetId?: string | null;
  /** Field names and non-secret facts only. */
  readonly metadata?: Record<string, unknown>;
}

export function writeAudit(db: Db, entry: AuditEntry, now = Date.now()): void {
  db.insert(schema.auditLogs)
    .values({
      orgId: entry.orgId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      action: entry.action,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      createdAt: now,
    })
    .run();
}
