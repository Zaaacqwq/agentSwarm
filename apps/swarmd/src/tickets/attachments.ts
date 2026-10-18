import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { asc, eq } from "drizzle-orm";
import type { TicketAttachmentView } from "@agentswarm/contracts";
import { imageSize } from "@agentswarm/ws-exec";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { RunOpening } from "../agents/run-service.ts";

const run = promisify(execFile);

export const MAX_ATTACHMENTS = 6;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Stored and given to the lead at most this big (longest side): plenty to see a bug, small in the context. */
const MAX_SIDE = 1600;

type Row = typeof schema.ticketAttachments.$inferSelect;

/** What a file says it is, from its first bytes (the name and the browser's type are not trusted). */
export function sniff(buf: Buffer): "jpeg" | "png" | "heic" | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length > 12 && buf.toString("ascii", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buf.toString("ascii", 8, 12))) return "heic";
  return null;
}

/**
 * Pictures attached to a ticket (R7): converted to JPEG (HEIC from an iPhone too), at most 1600 px, kept in
 * swarmd's data. When the ticket starts, its lead sees them in its first message and, unless the ticket says
 * otherwise, they are written into the worktree to be committed with the mission's documents.
 */
export class Attachments {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  list(ticketId: string): TicketAttachmentView[] {
    return this.rows(ticketId).map((r) => ({ id: r.id, name: r.name, width: r.width, height: r.height, bytes: r.bytes, url: `/api/tickets/${ticketId}/attachments/${r.id}` }));
  }

  private rows(ticketId: string): Row[] {
    return this.db.select().from(schema.ticketAttachments).where(eq(schema.ticketAttachments.ticketId, ticketId)).orderBy(asc(schema.ticketAttachments.createdAt)).all();
  }

  async add(ticketId: string, name: string, data: Buffer, now = Date.now()): Promise<TicketAttachmentView> {
    if (data.byteLength > MAX_UPLOAD_BYTES) throw badRequest("A picture may be at most 10 MB");
    const type = sniff(data);
    if (!type) throw badRequest("Attach a JPEG, PNG or HEIC picture");
    if (this.rows(ticketId).length >= MAX_ATTACHMENTS) throw conflict(`At most ${MAX_ATTACHMENTS} pictures per ticket`);
    const id = `att_${randomBytes(12).toString("hex")}`;
    const folder = join(this.dir, ticketId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const source = join(folder, `${id}.upload.${type === "heic" ? "heic" : type === "png" ? "png" : "jpg"}`);
    const file = `${id}.jpg`;
    writeFileSync(source, data, { mode: 0o600 });
    try {
      // -Z also enlarges: only a picture bigger than MAX_SIDE is scaled (down).
      const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", source], { timeout: 30_000 });
      const longest = Math.max(...[...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])));
      const scale = Number.isFinite(longest) && longest > MAX_SIDE ? ["-Z", String(MAX_SIDE)] : [];
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", ...scale, source, "--out", join(folder, file)], { timeout: 60_000 });
    } catch {
      rmSync(join(folder, file), { force: true });
      throw badRequest("That picture could not be read");
    } finally {
      rmSync(source, { force: true });
    }
    const stored = readFileSync(join(folder, file));
    const size = imageSize(stored);
    const clean = name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80) || "picture";
    this.db.insert(schema.ticketAttachments).values({ id, ticketId, name: clean, file, bytes: stored.byteLength, width: size.width, height: size.height, createdAt: now }).run();
    return this.list(ticketId).find((a) => a.id === id)!;
  }

  read(ticketId: string, id: string): Buffer {
    const row = this.rows(ticketId).find((r) => r.id === id);
    if (!row) throw notFound("No such picture");
    return readFileSync(join(this.dir, ticketId, row.file));
  }

  remove(ticketId: string, id: string): void {
    const row = this.rows(ticketId).find((r) => r.id === id);
    if (!row) throw notFound("No such picture");
    this.db.delete(schema.ticketAttachments).where(eq(schema.ticketAttachments.id, id)).run();
    rmSync(join(this.dir, ticketId, row.file), { force: true });
  }

  removeAll(ticketId: string): void {
    rmSync(join(this.dir, ticketId), { recursive: true, force: true });
  }

  /** The lead's first message gets the pictures; the worktree gets them under <docs>/request/ unless turned off. */
  async opening(ticket: { id: string; commitAttachments: boolean }, docsPath: string): Promise<RunOpening | null> {
    const rows = this.rows(ticket.id);
    if (!rows.length) return null;
    const pictures = rows.map((r, i) => ({ name: `${String(i + 1).padStart(2, "0")}-${r.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "picture"}.jpg`, data: readFileSync(join(this.dir, ticket.id, r.file)).toString("base64") }));
    return {
      images: pictures.map((p) => ({ data: p.data, mimeType: "image/jpeg" })),
      files: ticket.commitAttachments ? pictures.map((p) => ({ path: `${docsPath}/request/${p.name}`, base64: p.data })) : [],
    };
  }
}
