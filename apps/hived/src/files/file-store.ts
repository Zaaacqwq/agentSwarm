import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Attachment } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, notFound } from "../http/errors.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Uploads not yet attached to a message, per uploader; older ones are purged after a day. */
const MAX_UNBOUND_PER_UPLOADER = 30;
const UNBOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_READ = 200 * 1024;

/** Types we store and how we recognise them. The client's Content-Type is never trusted. */
const MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mime: "image/webp", test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { mime: "application/pdf", test: (b) => ascii(b, 0, 5) === "%PDF-" },
];

const TEXT_TYPES: Record<string, string> = { md: "text/markdown", csv: "text/csv", json: "application/json", log: "text/plain", txt: "text/plain", diff: "text/plain", patch: "text/plain" };

export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

/** Detects an allowed type from the bytes, or returns null. */
export function sniffMime(bytes: Uint8Array, filename: string): string | null {
  for (const m of MAGIC) if (bytes.length >= 12 && m.test(bytes)) return m.mime;
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_TYPES[ext] ?? "text/plain";
}

/** Keeps a readable, path-free name: no slashes, control characters or leading dots. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/^\.+/, "").trim().slice(0, 120);
  return cleaned || "file";
}

export interface Uploader {
  readonly kind: "user" | "agent";
  readonly id: string;
  readonly orgId: string;
}

/** Content-addressed channel attachments. Access always follows channel read permission. */
export class FileStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  save(uploader: Uploader, channelId: string, filename: string, bytes: Uint8Array, now = Date.now()): Attachment {
    if (bytes.byteLength === 0) throw badRequest("Empty file");
    if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const name = cleanFilename(filename);
    const mime = sniffMime(bytes, name);
    if (!mime) throw badRequest("Only images (PNG, JPEG, GIF, WebP), PDFs and UTF-8 text files are accepted");
    const pending = this.db.select({ id: schema.attachments.id }).from(schema.attachments)
      .where(and(eq(schema.attachments.uploaderKind, uploader.kind), eq(schema.attachments.uploaderId, uploader.id), isNull(schema.attachments.messageId))).all().length;
    if (pending >= MAX_UNBOUND_PER_UPLOADER) throw badRequest("Too many unsent uploads; send or discard them first");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const path = join(this.dir, sha256);
    if (!existsSync(path)) {
      // Write then rename, so a crash never leaves a truncated file under the content hash.
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    }
    const row = this.db.insert(schema.attachments).values({
      id: newId("file"), orgId: uploader.orgId, channelId, messageId: null, uploaderKind: uploader.kind, uploaderId: uploader.id,
      filename: name, mime, size: bytes.byteLength, sha256, createdAt: now,
    }).returning().get();
    return toAttachment(row);
  }

  /** Attaches uploads to a message: same channel, same uploader, not yet used. */
  bind(ids: readonly string[], messageId: number, channelId: string, uploader: { kind: "user" | "agent"; id: string }): void {
    if (ids.length === 0) return;
    const rows = this.db.select().from(schema.attachments).where(inArray(schema.attachments.id, [...ids])).all();
    const valid = rows.filter((r) => r.channelId === channelId && r.uploaderKind === uploader.kind && r.uploaderId === uploader.id && r.messageId === null);
    if (valid.length !== new Set(ids).size) throw badRequest("Attachments must be your own unused uploads to this channel");
    this.db.update(schema.attachments).set({ messageId }).where(and(inArray(schema.attachments.id, [...ids]), isNull(schema.attachments.messageId))).run();
  }

  /** Drops an upload that was never attached (e.g. its message was refused). */
  discard(id: string): void {
    this.db.delete(schema.attachments).where(and(eq(schema.attachments.id, id), isNull(schema.attachments.messageId))).run();
  }

  /** Forgets uploads that were never attached to a message within a day. Blobs stay (shared by hash). */
  purgeUnbound(now = Date.now()): void {
    this.db.delete(schema.attachments).where(and(isNull(schema.attachments.messageId), lt(schema.attachments.createdAt, now - UNBOUND_TTL_MS))).run();
  }

  get(id: string): (typeof schema.attachments.$inferSelect) | null {
    return this.db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get() ?? null;
  }

  bytes(id: string): { row: typeof schema.attachments.$inferSelect; data: Buffer } {
    const row = this.get(id);
    if (!row) throw notFound("File");
    return { row, data: readFileSync(join(this.dir, row.sha256)) };
  }

  /** Text content for agents (bounded). */
  readText(id: string): { filename: string; text: string; truncated: boolean } {
    const { row, data } = this.bytes(id);
    if (!row.mime.startsWith("text/") && row.mime !== "application/json") throw new Error(`${row.filename} is ${row.mime}; only text files can be read.`);
    const truncated = data.byteLength > MAX_TEXT_READ;
    return { filename: row.filename, text: data.subarray(0, MAX_TEXT_READ).toString("utf8"), truncated };
  }

  listForChannel(channelId: string): Attachment[] {
    return this.db.select().from(schema.attachments).where(eq(schema.attachments.channelId, channelId)).all()
      .filter((r) => r.messageId !== null).map(toAttachment).sort((a, b) => b.createdAt - a.createdAt);
  }
}

function toAttachment(row: typeof schema.attachments.$inferSelect): Attachment {
  return { id: row.id, channelId: row.channelId, messageId: row.messageId, filename: row.filename, mime: row.mime, size: row.size, createdAt: row.createdAt };
}
