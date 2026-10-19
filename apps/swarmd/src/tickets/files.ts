import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import { asc, eq } from "drizzle-orm";
import type { InboxFileView, TicketFileView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";

/** R10: files a ticket brings (an assignment, data, a document): at most this many, this big. */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const TEXT = new Set([
  "txt", "md", "csv", "tsv", "json", "ipynb", "py", "js", "mjs", "ts", "tsx", "jsx", "swift", "java", "kt", "c", "h", "cpp", "hpp", "cc", "rs", "go",
  "rb", "php", "html", "css", "sql", "xml", "yaml", "yml", "toml", "sh", "r", "m", "scala", "tex", "log",
]);
const ZIPPED = new Set(["zip", "docx", "xlsx", "pptx"]);

/** Whether the bytes are what the name says: a PDF, a zip (or an Office file), or UTF-8 text. Anything else is refused. */
export function fileKind(name: string, data: Buffer): "pdf" | "zip" | "text" | null {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "pdf") return data.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : null;
  if (ZIPPED.has(ext)) return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) ? "zip" : null;
  if (TEXT.has(ext)) {
    if (data.includes(0)) return null;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return "text";
    } catch {
      return null;
    }
  }
  return null;
}

/** A name that is safe in a worktree: letters, digits, spaces, dots, dashes; its extension kept. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/^\.+/, "").trim().slice(-100);
  return clean || "file";
}

type Row = typeof schema.ticketFiles.$inferSelect;

/**
 * Files attached to a ticket (R10), kept as they are in swarmd's data. When the ticket starts they are written into
 * the worktree's inputs/ folder, which is never committed.
 */
export class TicketFiles {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  list(ticketId: string): TicketFileView[] {
    return this.rows(ticketId).map((r) => ({ id: r.id, name: r.name, bytes: r.bytes, url: `/api/tickets/${ticketId}/files/${r.id}` }));
  }

  private rows(ticketId: string): Row[] {
    return this.db.select().from(schema.ticketFiles).where(eq(schema.ticketFiles.ticketId, ticketId)).orderBy(asc(schema.ticketFiles.createdAt)).all();
  }

  add(ticketId: string, name: string, data: Buffer, now = Date.now()): TicketFileView {
    if (data.byteLength > MAX_FILE_BYTES) throw badRequest(`A file may be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const clean = cleanName(name);
    if (!fileKind(clean, data)) throw badRequest("Attach a PDF, a zip (or Word, Excel, PowerPoint), or a text file: code, CSV, JSON, a notebook, Markdown");
    const rows = this.rows(ticketId);
    if (rows.length >= MAX_FILES) throw conflict(`At most ${MAX_FILES} files per ticket`);
    // Two files of the same name both arrive: the later one is numbered.
    const taken = new Set(rows.map((r) => r.name));
    let unique = clean;
    for (let i = 2; taken.has(unique); i++) unique = clean.replace(/(\.[^.]*)?$/, `-${i}$1`);
    const id = `fil_${randomBytes(12).toString("hex")}`;
    const folder = join(this.dir, ticketId, "files");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, id), data, { mode: 0o600 });
    this.db.insert(schema.ticketFiles).values({ id, ticketId, name: unique, file: id, bytes: data.byteLength, createdAt: now }).run();
    return this.list(ticketId).find((f) => f.id === id)!;
  }

  read(ticketId: string, id: string): { name: string; data: Buffer } {
    const row = this.rows(ticketId).find((r) => r.id === id);
    if (!row) throw notFound("No such file");
    return { name: row.name, data: readFileSync(join(this.dir, ticketId, "files", row.file)) };
  }

  remove(ticketId: string, id: string): void {
    const row = this.rows(ticketId).find((r) => r.id === id);
    if (!row) throw notFound("No such file");
    this.db.delete(schema.ticketFiles).where(eq(schema.ticketFiles.id, id)).run();
    rmSync(join(this.dir, ticketId, "files", row.file), { force: true });
  }

  /** A deleted ticket's files, rows and bytes. */
  removeAll(ticketId: string): void {
    this.db.delete(schema.ticketFiles).where(eq(schema.ticketFiles.ticketId, ticketId)).run();
    rmSync(join(this.dir, ticketId, "files"), { recursive: true, force: true });
  }

  /** What goes into the worktree when the ticket starts: inputs/<name>. */
  forWorktree(ticketId: string): { path: string; base64: string }[] {
    return this.rows(ticketId).map((r) => ({ path: `inputs/${r.name}`, base64: readFileSync(join(this.dir, ticketId, "files", r.file)).toString("base64") }));
  }
}

/**
 * The inbox on this Mac (R10): files you put in ~/agentSwarm-inbox, to attach without uploading. swarmd reads only
 * this folder's own files: no links, nothing outside it.
 */
export class Inbox {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  list(): InboxFileView[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.filter((n) => !n.startsWith(".")).flatMap((name) => {
      const st = lstatSync(join(this.dir, name));
      return st.isFile() ? [{ name, bytes: st.size, modifiedAt: st.mtimeMs }] : [];
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  read(name: string): Buffer {
    if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) throw badRequest("Name a file in the inbox");
    const path = join(this.dir, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      throw notFound("No such file in the inbox");
    }
    if (!st.isFile()) throw badRequest("Only plain files in the inbox can be attached");
    const real = realpathSync(path);
    if (!real.startsWith(realpathSync(this.dir) + sep)) throw badRequest("Only files in the inbox can be attached");
    // Opened without following links, and checked again once open: a file swapped for a link meanwhile is refused.
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw badRequest("Only plain files in the inbox can be attached");
    }
    try {
      const open = fstatSync(fd);
      if (!open.isFile()) throw badRequest("Only plain files in the inbox can be attached");
      if (open.size > MAX_FILE_BYTES) throw badRequest(`A file may be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
