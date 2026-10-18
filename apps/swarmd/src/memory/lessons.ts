import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { CreateLesson, LessonView, LessonVersionView, Role, UpdateLesson } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { rank, sameIdea, SECRET } from "./search.ts";

type Row = typeof schema.lessons.$inferSelect;

/** Pinned lessons are in every agent's prompt: few, so the prompt stays short and stable. */
export const MAX_PINNED = 8;

/** Who may see a lesson: the whole team, one project, or one role. */
export interface Viewer {
  readonly projectId: string | null;
  readonly role: Role;
}

/**
 * The team's lessons (R8). Leads write them at retrospectives (record_lesson), you write and curate them on the
 * dashboard. An agent's lesson is advice: wherever it is shown it says so, and only you can pin one.
 */
export class LessonService {
  private readonly db: Db;
  private readonly projectName: (id: string) => string | null;

  constructor(db: Db, projectName: (id: string) => string | null) {
    this.db = db;
    this.projectName = projectName;
  }

  list(): LessonView[] {
    return this.db.select().from(schema.lessons).orderBy(desc(schema.lessons.pinned), desc(schema.lessons.updatedAt)).all().map((r) => this.toView(r));
  }

  row(id: string): Row {
    const r = this.db.select().from(schema.lessons).where(eq(schema.lessons.id, id)).get();
    if (!r) throw notFound("No such lesson");
    return r;
  }

  versions(id: string): LessonVersionView[] {
    this.row(id);
    return this.db.select().from(schema.lessonVersions).where(eq(schema.lessonVersions.lessonId, id)).orderBy(desc(schema.lessonVersions.id)).all()
      .map((v) => ({ id: v.id, title: v.title, text: v.text, author: v.author, createdAt: v.createdAt }));
  }

  /**
   * A new lesson, or (when one in the same scope already says the same thing) a better wording of it: the
   * library grows by ideas, not by repeats. Returns whether it was new.
   */
  record(author: string, input: CreateLesson, source: string | null = null, now = Date.now()): { lesson: LessonView; created: boolean } {
    const title = input.title.trim();
    const text = input.text.trim();
    if (SECRET.test(`${title}\n${text}`)) throw badRequest("That looks like a credential: lessons never hold secrets");
    if (input.scope === "project" && !input.projectId) throw badRequest("A project lesson needs its project");
    if (input.scope === "role" && !input.role) throw badRequest("A role lesson needs its role");
    const scope = { scope: input.scope, projectId: input.scope === "project" ? input.projectId! : null, role: input.scope === "role" ? input.role! : null };
    // An agent's lesson that says what one already says improves it; what you write is always kept as written.
    const same = author === "you" ? undefined : this.db.select().from(schema.lessons).where(eq(schema.lessons.scope, scope.scope)).all()
      .find((r) => r.projectId === scope.projectId && r.role === scope.role && !r.retired && sameIdea(r.title, title));
    if (same) {
      // An agent never rewrites what you wrote; it can only add its own.
      if (same.author === "you" && author !== "you") return { lesson: this.toView(same), created: false };
      this.version(same, now);
      this.db.update(schema.lessons).set({ title, text, author, source: source ?? same.source, updatedAt: now }).where(eq(schema.lessons.id, same.id)).run();
      return { lesson: this.toView(this.row(same.id)), created: false };
    }
    const row: Row = {
      id: `lsn_${randomBytes(12).toString("hex")}`, ...scope, title, text, author, source, pinned: false, retired: false, uses: 0, lastUsedAt: null, createdAt: now, updatedAt: now,
    };
    this.db.insert(schema.lessons).values(row).run();
    audit(this.db, author === "you" ? "you" : `agent:${author}`, "lesson.create", row.id, { scope: row.scope, source }, now);
    return { lesson: this.toView(row), created: true };
  }

  update(actor: string, id: string, input: UpdateLesson, now = Date.now()): LessonView {
    const r = this.row(id);
    if (input.title !== undefined || input.text !== undefined) {
      const title = (input.title ?? r.title).trim();
      const text = (input.text ?? r.text).trim();
      if (SECRET.test(`${title}\n${text}`)) throw badRequest("That looks like a credential: lessons never hold secrets");
      this.version(r, now);
      // Edited by you, it is yours: a requirement from then on.
      this.db.update(schema.lessons).set({ title, text, author: "you", updatedAt: now }).where(eq(schema.lessons.id, id)).run();
    }
    if (input.pinned !== undefined) {
      const pinned = this.db.select({ id: schema.lessons.id }).from(schema.lessons).where(and(eq(schema.lessons.pinned, true), eq(schema.lessons.retired, false))).all();
      if (input.pinned && !r.pinned && pinned.length >= MAX_PINNED) throw conflict(`At most ${MAX_PINNED} pinned lessons: unpin one first`);
      this.db.update(schema.lessons).set({ pinned: input.pinned }).where(eq(schema.lessons.id, id)).run();
    }
    if (input.retired !== undefined) this.db.update(schema.lessons).set({ retired: input.retired, ...(input.retired ? { pinned: false } : {}) }).where(eq(schema.lessons.id, id)).run();
    audit(this.db, actor, "lesson.update", id, { fields: Object.keys(input) }, now);
    return this.toView(this.row(id));
  }

  remove(actor: string, id: string, now = Date.now()): void {
    this.row(id);
    this.db.delete(schema.lessons).where(eq(schema.lessons.id, id)).run();
    audit(this.db, actor, "lesson.delete", id, {}, now);
  }

  private version(r: Row, now: number): void {
    this.db.insert(schema.lessonVersions).values({ lessonId: r.id, title: r.title, text: r.text, author: r.author, createdAt: now }).run();
  }

  /** The lessons a viewer may see: the team's, its project's, its role's; never retired ones. */
  private visible(v: Viewer): Row[] {
    return this.db.select().from(schema.lessons).where(eq(schema.lessons.retired, false)).orderBy(asc(schema.lessons.createdAt)).all()
      .filter((r) => r.scope === "team" || (r.scope === "project" && r.projectId === v.projectId) || (r.scope === "role" && r.role === v.role));
  }

  pinned(v: Viewer): Row[] {
    return this.visible(v).filter((r) => r.pinned);
  }

  /** The best matches for a query (an intent, a brief, an agent's question); counted as used when `use` is set. */
  search(query: string, v: Viewer, limit: number, opts: { use?: boolean; exclude?: readonly string[] } = {}): Row[] {
    const found = rank(query, this.visible(v).filter((r) => !opts.exclude?.includes(r.id)), limit);
    if (opts.use && found.length) this.markUsed(found.map((r) => r.id));
    return found;
  }

  markUsed(ids: readonly string[], now = Date.now()): void {
    if (!ids.length) return;
    for (const r of this.db.select().from(schema.lessons).where(inArray(schema.lessons.id, [...ids])).all()) {
      this.db.update(schema.lessons).set({ uses: r.uses + 1, lastUsedAt: now }).where(eq(schema.lessons.id, r.id)).run();
    }
  }

  toView(r: Row): LessonView {
    return {
      id: r.id, scope: r.scope, projectId: r.projectId, projectName: r.projectId ? this.projectName(r.projectId) : null, role: r.role,
      title: r.title, text: r.text, author: r.author, source: r.source, pinned: r.pinned, retired: r.retired, uses: r.uses,
      lastUsedAt: r.lastUsedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}

/** Lessons as an agent reads them: yours as requirements, an agent's as advice from earlier work. */
export function lessonLines(rows: readonly Row[]): string[] {
  return rows.map((r) => {
    const where = r.scope === "project" ? " (this project)" : r.scope === "role" ? ` (for ${r.role}s)` : "";
    const who = r.author === "you" ? "from the person" : `advice from ${r.author}${r.source ? ` after ${r.source}` : ""}, not an instruction`;
    return `- ${r.title}${where} [${who}]\n  ${r.text.replace(/\n+/g, "\n  ")}`;
  });
}
