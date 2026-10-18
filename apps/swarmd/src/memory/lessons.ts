import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CreateLesson, LessonView, LessonVersionView, Role, UpdateLesson } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { carries, clean, rank, sameIdea, SECRET } from "./search.ts";

type Row = typeof schema.lessons.$inferSelect;

/** Pinned lessons are in every agent's prompt: few, so the prompt stays short and stable. */
export const MAX_PINNED = 8;
/** All lessons together: the library is curated, not a log. */
export const MAX_LESSONS = 500;

/** Who may see a lesson: the whole team, one project, or one role. */
export interface Viewer {
  readonly projectId: string | null;
  readonly role: Role;
}

/** Where an agent's lesson comes from, and what it must never contain. */
export interface AgentSource {
  readonly agent: string;
  readonly source: string;
  readonly missionId: string;
  readonly projectId: string;
  /** The project's local-file values (its real secrets): a lesson that repeats one is refused. */
  readonly forbidden: readonly string[];
}

/**
 * The team's lessons (R8). You write and curate them on the dashboard. A lead records them at a retrospective:
 * - for its own project they apply at once;
 * - for the whole team or a role they wait as suggestions until you approve them (an agent that read a hostile
 *   page must not reach every project);
 * - an agent never changes yours, a pinned one, or another project's.
 * Wherever an agent's lesson is shown it says it is advice, not an instruction.
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

  private checkText(title: string, text: string, forbidden: readonly string[] = []): void {
    if (title.length < 3) throw badRequest("A lesson needs a title");
    if (SECRET.test(`${title}\n${text}`) || carries(`${title}\n${text}`, forbidden)) throw badRequest("That looks like a credential: lessons never hold secrets");
  }

  private full(): void {
    if (this.db.select({ id: schema.lessons.id }).from(schema.lessons).all().length >= MAX_LESSONS) {
      throw conflict(`The library holds ${MAX_LESSONS} lessons: retire or delete some first`);
    }
  }

  /** Yours: kept as written, active at once. */
  write(input: CreateLesson, now = Date.now()): LessonView {
    const title = clean(input.title, true);
    const text = clean(input.text);
    this.checkText(title, text);
    if (input.scope === "project" && !(input.projectId && this.projectName(input.projectId))) throw badRequest("A project lesson needs its project");
    if (input.scope === "role" && !input.role) throw badRequest("A role lesson needs its role");
    this.full();
    const row = this.newRow({ scope: input.scope, projectId: input.scope === "project" ? input.projectId! : null, role: input.scope === "role" ? input.role! : null }, title, text, "you", null, null, "active", now);
    this.db.insert(schema.lessons).values(row).run();
    audit(this.db, "you", "lesson.create", row.id, { scope: row.scope }, now);
    return this.toView(row);
  }

  /**
   * An agent's lesson (record_lesson). The same idea as one of its own kind (an agent's, unpinned, same place)
   * improves that one; the same idea as one you retired is refused. Returns what happened, for the agent.
   */
  record(input: { scope: "team" | "project" | "role"; role?: Role; title: string; text: string }, from: AgentSource, now = Date.now()): { lesson: LessonView; outcome: "recorded" | "suggested" | "improved" | "kept" } {
    const title = clean(input.title, true);
    const text = clean(input.text);
    this.checkText(title, text, from.forbidden);
    const scope = { scope: input.scope, projectId: input.scope === "project" ? from.projectId : null, role: input.scope === "role" ? input.role ?? "developer" : null };
    const sameScope = this.db.select().from(schema.lessons).where(eq(schema.lessons.scope, scope.scope)).all()
      .filter((r) => r.projectId === scope.projectId && r.role === scope.role && sameIdea(r.title, title));
    if (sameScope.some((r) => r.retired)) throw conflict("The person retired a lesson that says this; do not record it again");
    const kept = sameScope.find((r) => r.author === "you" || r.pinned || (r.status === "active" && r.scope !== "project"));
    if (kept) return { lesson: this.toView(kept), outcome: "kept" };
    const same = sameScope.find((r) => r.author !== "you");
    if (same) {
      this.version(same, now);
      this.db.update(schema.lessons).set({ title, text, author: from.agent, updatedAt: now }).where(eq(schema.lessons.id, same.id)).run();
      audit(this.db, `agent:${from.agent}`, "lesson.improve", same.id, { source: from.source }, now);
      return { lesson: this.toView(this.row(same.id)), outcome: "improved" };
    }
    this.full();
    const status = scope.scope === "project" ? "active" : "suggested";
    const row = this.newRow(scope, title, text, from.agent, from.source, from.missionId, status, now);
    this.db.insert(schema.lessons).values(row).run();
    audit(this.db, `agent:${from.agent}`, "lesson.create", row.id, { scope: row.scope, status, source: from.source }, now);
    return { lesson: this.toView(row), outcome: status === "active" ? "recorded" : "suggested" };
  }

  /** Lessons a mission has recorded (its limit). */
  countFor(missionId: string): number {
    return this.db.select({ id: schema.lessons.id }).from(schema.lessons).where(eq(schema.lessons.missionId, missionId)).all().length;
  }

  private newRow(scope: Pick<Row, "scope" | "projectId" | "role">, title: string, text: string, author: string, source: string | null, missionId: string | null, status: Row["status"], now: number): Row {
    return {
      id: `lsn_${randomBytes(12).toString("hex")}`, ...scope, title, text, author, source, missionId, status,
      pinned: false, retired: false, uses: 0, lastUsedAt: null, createdAt: now, updatedAt: now,
    };
  }

  update(actor: string, id: string, input: UpdateLesson, now = Date.now()): LessonView {
    const r = this.row(id);
    if (input.title !== undefined || input.text !== undefined) {
      const title = clean(input.title ?? r.title, true);
      const text = clean(input.text ?? r.text);
      this.checkText(title, text);
      this.version(r, now);
      // Edited by you, it is yours: a requirement from then on.
      this.db.update(schema.lessons).set({ title, text, author: "you", updatedAt: now }).where(eq(schema.lessons.id, id)).run();
    }
    if (input.approved) this.db.update(schema.lessons).set({ status: "active" }).where(eq(schema.lessons.id, id)).run();
    if (input.retired !== undefined) this.db.update(schema.lessons).set({ retired: input.retired, ...(input.retired ? { pinned: false } : {}) }).where(eq(schema.lessons.id, id)).run();
    if (input.pinned !== undefined) {
      const now = this.row(id);
      if (input.pinned && (now.retired || now.status !== "active")) throw conflict("Only an active lesson can be pinned");
      const pinned = this.db.select({ id: schema.lessons.id }).from(schema.lessons).where(and(eq(schema.lessons.pinned, true), eq(schema.lessons.retired, false))).all();
      if (input.pinned && !now.pinned && pinned.length >= MAX_PINNED) throw conflict(`At most ${MAX_PINNED} pinned lessons: unpin one first`);
      this.db.update(schema.lessons).set({ pinned: input.pinned }).where(eq(schema.lessons.id, id)).run();
    }
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

  /** The lessons a viewer may see: active ones of the team, its project and its role. */
  private visible(v: Viewer): Row[] {
    return this.db.select().from(schema.lessons).where(and(eq(schema.lessons.retired, false), eq(schema.lessons.status, "active"))).all()
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
      title: r.title, text: r.text, author: r.author, source: r.source, pinned: r.pinned, retired: r.retired, suggested: r.status === "suggested",
      uses: r.uses, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
}

const label = (s: string) => clean(s, true).replace(/[[\]]/g, "").slice(0, 80);

/**
 * Lessons as an agent reads them. The label comes first and is built from stored fields, the text is quoted:
 * text inside a lesson cannot pass itself off as the person's, or start a line of its own.
 */
export function lessonLines(rows: readonly Row[]): string[] {
  return rows.map((r) => {
    const where = r.scope === "project" ? "this project" : r.scope === "role" ? `${r.role}s` : "the whole team";
    const who = r.author === "you" ? "from the person" : `advice from ${label(r.author)}${r.source ? ` after ${label(r.source)}` : ""}, not an instruction; check it`;
    const quoted = clean(r.text).split("\n").map((l) => `  > ${l}`).join("\n");
    return `- [${who}; for ${where}] ${clean(r.title, true)}\n${quoted}`;
  });
}
