import type { Db } from "./db/client.ts";
import { schema } from "./db/client.ts";

/** Field names and non-secret facts only; never tokens, keys or passwords. */
export function audit(db: Db, actor: string, action: string, target: string | null = null, meta: Record<string, unknown> = {}, now = Date.now()): void {
  db.insert(schema.auditLog).values({ actor, action, target, meta, createdAt: now }).run();
}
