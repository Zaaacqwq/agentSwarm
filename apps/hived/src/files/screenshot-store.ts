import { and, asc, desc, eq, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Screenshot } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { notFound } from "../http/errors.ts";

/** Total bytes kept for screenshots; the oldest go first. */
export const SCREENSHOT_POOL_BYTES = 2 * 1024 * 1024 * 1024;

type Row = typeof schema.screenshots.$inferSelect;

export interface NewScreenshot {
  readonly orgId: string;
  readonly agentId: string;
  readonly runId: string | null;
  readonly source: Screenshot["source"];
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Agent screenshots in the content-addressed files dir, capped in total size. */
export class ScreenshotStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly capBytes = SCREENSHOT_POOL_BYTES,
    private readonly onCreated: (orgId: string, shot: Screenshot) => void = () => {},
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  save(input: NewScreenshot, now = Date.now()): Screenshot {
    const sha256 = new Bun.CryptoHasher("sha256").update(input.jpeg).digest("hex");
    const path = join(this.dir, sha256);
    if (!existsSync(path)) {
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      writeFileSync(tmp, input.jpeg, { mode: 0o600 });
      renameSync(tmp, path);
    }
    const row = this.db.insert(schema.screenshots).values({
      id: newId("shot"), orgId: input.orgId, agentId: input.agentId, runId: input.runId, source: input.source,
      sha256, size: input.jpeg.byteLength, width: input.width, height: input.height, createdAt: now,
    }).returning().get();
    this.enforceCap();
    const shot = toScreenshot(row);
    this.onCreated(input.orgId, shot);
    return shot;
  }

  bytes(orgId: string, id: string): { row: Row; data: Buffer } {
    const row = this.db.select().from(schema.screenshots).where(and(eq(schema.screenshots.id, id), eq(schema.screenshots.orgId, orgId))).get();
    if (!row) throw notFound("Screenshot");
    const path = join(this.dir, row.sha256);
    if (!existsSync(path)) throw notFound("Screenshot");
    return { row, data: readFileSync(path) };
  }

  listForAgent(orgId: string, agentId: string, limit = 50): Screenshot[] {
    return this.db.select().from(schema.screenshots).where(and(eq(schema.screenshots.orgId, orgId), eq(schema.screenshots.agentId, agentId)))
      .orderBy(desc(schema.screenshots.createdAt)).limit(limit).all().map(toScreenshot);
  }

  totalBytes(): number {
    return this.db.select({ n: sql<number>`coalesce(sum(${schema.screenshots.size}), 0)` }).from(schema.screenshots).get()?.n ?? 0;
  }

  /** Deletes the oldest screenshots over the cap; blobs go once nothing else uses that hash. */
  enforceCap(): void {
    let total = this.totalBytes();
    while (total > this.capBytes) {
      const oldest = this.db.select().from(schema.screenshots).orderBy(asc(schema.screenshots.createdAt), asc(schema.screenshots.id)).limit(50).all();
      if (oldest.length === 0) return;
      for (const row of oldest) {
        if (total <= this.capBytes) break;
        this.db.delete(schema.screenshots).where(eq(schema.screenshots.id, row.id)).run();
        total -= row.size;
        const shared = this.db.select({ id: schema.screenshots.id }).from(schema.screenshots).where(eq(schema.screenshots.sha256, row.sha256)).get()
          ?? this.db.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.sha256, row.sha256)).get();
        if (!shared) rmSync(join(this.dir, row.sha256), { force: true });
      }
    }
  }
}

function toScreenshot(row: Row): Screenshot {
  return { id: row.id, agentId: row.agentId, runId: row.runId, source: row.source, width: row.width, height: row.height, size: row.size, createdAt: row.createdAt };
}
