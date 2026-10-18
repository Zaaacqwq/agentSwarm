import { and, asc, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { CreateTicket, LiveMessage, MissionView, MoveTicket, TicketEventView, TicketNeed, TicketSettings, TicketStatus, TicketView, UpdateTicket } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { AgentService } from "../agents/agent-service.ts";
import type { RunService } from "../agents/run-service.ts";
import type { MissionService } from "../missions/mission-service.ts";
import { ticketPrefixOf, type ProjectService } from "../projects/project-service.ts";
import type { Attachments } from "./attachments.ts";
import type { TreeService } from "../agents/tree-service.ts";
import type { GitHubService } from "../github/github-service.ts";
import { gitOk, type GitRunner } from "../github/git.ts";

export type TicketRow = typeof schema.tickets.$inferSelect;
type Actor = string;

/** Who the system acts as in the record. */
export const SYSTEM = "agentswarm";
const SETTINGS_ROW = "tickets";
const DEFAULT_MAX_ACTIVE = 3;
/** Yours to set; the others follow the ticket's mission. */
const YOURS = new Set<TicketStatus>(["backlog", "todo", "canceled"]);
const OPEN = new Set<TicketStatus>(["in_progress", "needs_you"]);
const SPACE_PREFIX = { sandbox: "SBX", ideas: "IDEA" } as const;

export interface TicketDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly missions: MissionService;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly runs: RunService;
  readonly attachments: Attachments;
  readonly tree: TreeService;
  readonly github: GitHubService;
  readonly git: GitRunner;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Tells you a ticket needs you, finished or failed (Discord), with a link to it. */
  readonly notify?: (ticket: TicketView, what: string) => void;
}

const newId = () => `tkt_${randomBytes(16).toString("hex")}`;
export const keyOf = (t: Pick<TicketRow, "prefix" | "number">) => `${t.prefix}-${t.number}`;

/**
 * The board (R7): your tickets, and the queue that turns them into missions. Backlog and todo are yours;
 * a todo ticket starts when a slot is free (by priority, then your order); from then on its mission's
 * stage decides whether it is in progress, needs you, done or canceled.
 */
export class TicketService {
  private readonly deps: TicketDeps;
  private pumping: Promise<void> = Promise.resolve();
  /** The last status and need seen per mission ticket, to notify once per change. */
  private readonly seen = new Map<string, string>();

  constructor(deps: TicketDeps) {
    this.deps = deps;
    deps.bus.subscribe((m) => this.onLive(m));
    // The lead of a ticket's mission gets the ticket's pictures when it first starts.
    deps.missions.onOpening(async (m) => {
      const t = this.byMission(m.id);
      return t ? this.deps.attachments.opening(t, m.docsPath) : null;
    });
    deps.missions.onFileTicket((m, agent, input) => {
      const t = this.fileFromAgent(m.id, agent, input);
      return `Filed ${t.key} in the backlog. The person decides whether and when to do it; carry on with this ticket.`;
    });
  }

  // ---- reading -----------------------------------------------------------------------------

  list(): TicketView[] {
    const rows = this.deps.db.select().from(schema.tickets).orderBy(asc(schema.tickets.status), asc(schema.tickets.position)).all();
    const queue = this.queueOrder(rows);
    return rows.map((r) => this.toView(r, queue));
  }

  row(idOrKey: string): TicketRow {
    const m = /^([A-Z][A-Z0-9]{0,5})-(\d{1,7})$/.exec(idOrKey);
    const row = m
      ? this.deps.db.select().from(schema.tickets).where(and(eq(schema.tickets.prefix, m[1]!), eq(schema.tickets.number, Number(m[2])))).get()
      : this.deps.db.select().from(schema.tickets).where(eq(schema.tickets.id, idOrKey)).get();
    if (!row) throw notFound(`No ticket ${idOrKey}`);
    return row;
  }

  view(idOrKey: string): TicketView {
    return this.toView(this.row(idOrKey));
  }

  byMission(missionId: string): TicketRow | null {
    return this.deps.db.select().from(schema.tickets).where(eq(schema.tickets.missionId, missionId)).get() ?? null;
  }

  events(idOrKey: string): TicketEventView[] {
    const t = this.row(idOrKey);
    return this.deps.db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, t.id)).orderBy(asc(schema.ticketEvents.id)).all()
      .map((e) => ({ id: e.id, ticketId: e.ticketId, actor: e.actor, kind: e.kind, data: e.data, createdAt: e.createdAt }));
  }

  settings(): TicketSettings {
    const v = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, SETTINGS_ROW)).get()?.value as Partial<TicketSettings> | undefined;
    return { maxActive: v?.maxActive ?? DEFAULT_MAX_ACTIVE };
  }

  setSettings(actor: Actor, input: TicketSettings, now = Date.now()): TicketSettings {
    const values = { value: { maxActive: input.maxActive }, updatedAt: now };
    this.deps.db.insert(schema.settings).values({ id: SETTINGS_ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
    audit(this.deps.db, actor, "tickets.settings", null, { maxActive: input.maxActive }, now);
    void this.pump();
    return this.settings();
  }

  // ---- your changes ------------------------------------------------------------------------

  create(actor: Actor, input: CreateTicket, now = Date.now(), from: { by: string; ticketId: string } | null = null, external: { key: string; url: string } | null = null): TicketView {
    const { prefix, projectId } = this.place(input.space, input.projectId ?? null, input.kind);
    const status = input.status ?? "backlog";
    const row = this.deps.db.transaction(() => {
      const number = (this.deps.db.select({ n: max(schema.tickets.number) }).from(schema.tickets).where(eq(schema.tickets.prefix, prefix)).get()?.n ?? 0) + 1;
      const row: TicketRow = {
        id: newId(), prefix, number, space: input.space, projectId, title: input.title.trim(), description: input.description.trim(), kind: input.kind,
        priority: input.priority ?? 0, status, position: this.topOf(status), missionId: null, createdBy: from?.by ?? "you", fromTicketId: from?.ticketId ?? null,
        commitAttachments: input.commitAttachments ?? true, external, createdAt: now, updatedAt: now, startedAt: null, endedAt: null,
      };
      this.deps.db.insert(schema.tickets).values(row).run();
      return row;
    }, { behavior: "immediate" });
    this.event(row.id, from?.by ?? actor, "created", { status, ...(from ? { from: from.ticketId } : {}), ...(external ? { external: external.key } : {}) }, now);
    audit(this.deps.db, actor, "ticket.create", row.id, { key: keyOf(row), status }, now);
    this.emit(row.id);
    if (status === "todo") void this.pump();
    return this.view(row.id);
  }

  /** Where a ticket goes: its project's prefix, or SBX and IDEA for work that has no project yet. */
  private place(space: TicketRow["space"], projectId: string | null, kind: TicketRow["kind"]): { prefix: string; projectId: string | null } {
    if (space === "sandbox") {
      if (kind !== "experiment") throw badRequest("The sandbox runs experiments");
      return { prefix: SPACE_PREFIX.sandbox, projectId: null };
    }
    if (space === "ideas") {
      if (kind !== "research") throw badRequest("An idea is researched first (kind research); make it a project when it is worth building");
      return { prefix: SPACE_PREFIX.ideas, projectId: null };
    }
    if (!projectId) throw badRequest("Choose a project");
    const project = this.deps.projects.get(projectId);
    if (project.kind === "local" && kind !== "research" && kind !== "experiment") throw badRequest("A local project runs research and experiments only");
    if (project.kind === "github" && kind === "experiment") throw badRequest("Experiments run in the sandbox");
    return { prefix: ticketPrefixOf(project), projectId: project.id };
  }

  update(actor: Actor, idOrKey: string, input: UpdateTicket, now = Date.now()): TicketView {
    const t = this.row(idOrKey);
    if (t.missionId) throw conflict(`${keyOf(t)} has started: add to it by writing to its lead`);
    const space = input.space ?? t.space;
    const kind = input.kind ?? t.kind;
    const projectId = input.projectId !== undefined ? input.projectId : t.projectId;
    const placed = this.place(space, projectId, kind);
    // Moving it to another project gives it that project's next number.
    const moved = placed.prefix !== t.prefix;
    const number = moved ? (this.deps.db.select({ n: max(schema.tickets.number) }).from(schema.tickets).where(eq(schema.tickets.prefix, placed.prefix)).get()?.n ?? 0) + 1 : t.number;
    const changes = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.commitAttachments !== undefined ? { commitAttachments: input.commitAttachments } : {}),
      kind, space, projectId: placed.projectId, prefix: placed.prefix, number, updatedAt: now,
    };
    this.deps.db.update(schema.tickets).set(changes).where(eq(schema.tickets.id, t.id)).run();
    this.event(t.id, actor, "edited", { fields: Object.keys(input), ...(moved ? { was: keyOf(t) } : {}) }, now);
    audit(this.deps.db, actor, "ticket.update", t.id, { fields: Object.keys(input) }, now);
    this.emit(t.id);
    void this.pump();
    return this.view(t.id);
  }

  /**
   * You move a ticket to backlog, todo or canceled, in a place among its neighbours. A started ticket can
   * only be canceled (its mission is stopped); its other columns follow the mission.
   */
  move(actor: Actor, idOrKey: string, input: MoveTicket, now = Date.now()): TicketView {
    const t = this.row(idOrKey);
    if (t.missionId && input.status !== "canceled") throw conflict(`${keyOf(t)} has started: its column follows its mission`);
    if (t.missionId) {
      if (!OPEN.has(t.status)) throw conflict(`${keyOf(t)} has ended`);
      // Stopping the mission moves the ticket (sync), with the record and the freed slot.
      this.deps.missions.cancel(actor, t.missionId);
      return this.view(t.id);
    }
    const position = this.placeBetween(t.id, input.status, input.after ?? null, input.before ?? null);
    const status = input.status;
    this.deps.db.update(schema.tickets).set({ status, position, updatedAt: now, ...(status === "canceled" ? { endedAt: t.endedAt ?? now } : {}) }).where(eq(schema.tickets.id, t.id)).run();
    if (status !== t.status) this.event(t.id, actor, "status", { from: t.status, to: status }, now);
    audit(this.deps.db, actor, "ticket.move", t.id, { from: t.status, to: status }, now);
    this.emit(t.id);
    void this.pump();
    return this.view(t.id);
  }

  remove(actor: Actor, idOrKey: string, now = Date.now()): void {
    const t = this.row(idOrKey);
    if (t.missionId) throw conflict(`${keyOf(t)} has a mission: cancel it instead, so its record stays`);
    this.deps.attachments.removeAll(t.id);
    this.deps.db.delete(schema.tickets).where(eq(schema.tickets.id, t.id)).run();
    audit(this.deps.db, actor, "ticket.delete", t.id, { key: keyOf(t) }, now);
    this.deps.bus.publish({ kind: "ticket", ticket: { ...this.toView(t), status: "canceled" } });
  }

  /** A follow-up a lead noticed (file_ticket): it waits in the backlog until you move it. */
  fileFromAgent(missionId: string, agentName: string, input: { title: string; description: string; kind: "feature" | "bug" | "research" }, now = Date.now()): TicketView {
    const from = this.byMission(missionId);
    if (!from) throw badRequest("Only work that came from a ticket can file tickets");
    const sameProject = from.space === "project" && from.projectId;
    return this.create(SYSTEM, {
      space: sameProject ? "project" : "ideas", ...(sameProject ? { projectId: from.projectId! } : {}),
      title: input.title, description: input.description, kind: sameProject ? input.kind : "research", status: "backlog", priority: 0,
    }, now, { by: agentName, ticketId: from.id });
  }

  // ---- pictures ----------------------------------------------------------------------------

  async attach(actor: Actor, idOrKey: string, name: string, data: Buffer, now = Date.now()): Promise<TicketView> {
    const t = this.row(idOrKey);
    if (t.missionId) throw conflict(`${keyOf(t)} has started: show its lead in the conversation instead`);
    const a = await this.deps.attachments.add(t.id, name, data, now);
    this.event(t.id, actor, "attachment", { added: a.name }, now);
    this.emit(t.id);
    return this.view(t.id);
  }

  picture(ticketId: string, attachmentId: string): Buffer {
    return this.deps.attachments.read(ticketId, attachmentId);
  }

  detach(actor: Actor, idOrKey: string, attachmentId: string, now = Date.now()): TicketView {
    const t = this.row(idOrKey);
    if (t.missionId) throw conflict(`${keyOf(t)} has started; its pictures are part of the record`);
    this.deps.attachments.remove(t.id, attachmentId);
    this.event(t.id, actor, "attachment", { removed: attachmentId }, now);
    this.emit(t.id);
    return this.view(t.id);
  }

  // ---- 立项: an idea or experiment becomes a project ----------------------------------------

  /**
   * A finished research or experiment ticket becomes a project: a private repository whose main is what the
   * mission produced, registered here, and a new feature ticket (in todo) to build it. Each step is skipped
   * when already done, so promoting again continues where a failure stopped.
   */
  async promote(actor: Actor, idOrKey: string, givenRepo: string | null, now = Date.now()): Promise<TicketView> {
    const t = this.row(idOrKey);
    const { projects, github, missions, git } = this.deps;
    if (t.status !== "done" || !t.missionId || (t.kind !== "research" && t.kind !== "experiment")) throw conflict("Only a finished research or experiment ticket becomes a project");
    const done = this.events(t.id).find((e) => e.kind === "promoted" && e.data.ticket);
    if (done) throw conflict(`${keyOf(t)} is already a project: ${String(done.data.ticket)}`);
    const old = missions.row(t.missionId);
    const local = projects.get(old.projectId);
    const root = this.deps.tree.run(old.rootRunId);
    const token = await github.token();
    let repo = givenRepo ?? (this.events(t.id).find((e) => e.kind === "promoted" && e.data.repo)?.data.repo as string | undefined) ?? null;
    if (!repo) {
      const name = t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `project-${keyOf(t).toLowerCase()}`;
      try {
        repo = (await github.client.createRepo(token, name, t.title)).fullName;
      } catch (error) {
        throw conflict(`GitHub did not create a repository (${(error as Error).message.slice(0, 200)}). Create an empty private one and give its name (owner/repo).`);
      }
      // Remembered before anything else can fail: a retry reuses it instead of creating another.
      this.event(t.id, actor, "promoted", { repo }, now);
    }
    let project = projects.list().find((p) => p.githubRepo.toLowerCase() === repo!.toLowerCase());
    if (!project) {
      // What it produced is on its mission branch: that becomes main (not forced: an existing main stays).
      await gitOk(git, ["push", "--quiet", projects.remoteUrlFor(repo), `refs/heads/${root.branch}:refs/heads/main`], { cwd: local.mirrorPath, token, timeoutMs: 300_000 });
      project = await projects.create(actor, { githubRepo: repo, name: t.title.slice(0, 80) });
    }
    const docs = old.docs.map((d) => `${old.docsPath}/${d}`).join(", ");
    const next = this.create(actor, {
      space: "project", projectId: project.id, kind: "feature", status: "todo", priority: t.priority, title: t.title,
      description: `${t.description}\n\nThis started as ${keyOf(t)} (${t.kind === "experiment" ? "an experiment" : "an idea"}); what was found is already in this repository (${docs || old.docsPath}). Conclusion:\n${old.retro ?? old.stageSummary ?? ""}`.slice(0, 8000),
    }, Date.now(), { by: "you", ticketId: t.id });
    this.event(t.id, actor, "promoted", { repo, project: project.id, ticket: next.key }, Date.now());
    audit(this.deps.db, actor, "ticket.promote", t.id, { repo, ticket: next.key }, now);
    this.emit(t.id);
    return next;
  }

  // ---- order -------------------------------------------------------------------------------

  private positions(status: TicketStatus, except: string | null = null): { id: string; position: number }[] {
    return this.deps.db.select({ id: schema.tickets.id, position: schema.tickets.position }).from(schema.tickets)
      .where(eq(schema.tickets.status, status)).orderBy(asc(schema.tickets.position)).all().filter((r) => r.id !== except);
  }

  private topOf(status: TicketStatus): number {
    return (this.positions(status)[0]?.position ?? 1) - 1;
  }

  /** Right below `after`, else right above `before`, else on top; renumbers the column when there is no room. */
  private placeBetween(id: string, status: TicketStatus, after: string | null, before: string | null): number {
    let col = this.positions(status, id);
    const at = (i: number) => {
      const lo = i > 0 ? col[i - 1]!.position : col[0] ? col[0].position - 2 : 0;
      const hi = i < col.length ? col[i]!.position : lo + 2;
      return { lo, hi };
    };
    let index = 0;
    const ai = after ? col.findIndex((r) => r.id === after) : -1;
    const bi = before ? col.findIndex((r) => r.id === before) : -1;
    if (ai >= 0) index = ai + 1;
    else if (bi >= 0) index = bi;
    let { lo, hi } = at(index);
    if (hi - lo < 1e-6) {
      // No room left between them: spread the column out again.
      col.forEach((r, i) => this.deps.db.update(schema.tickets).set({ position: i * 1024 }).where(eq(schema.tickets.id, r.id)).run());
      col = this.positions(status, id);
      ({ lo, hi } = at(index));
    }
    return (lo + hi) / 2;
  }

  // ---- the queue ---------------------------------------------------------------------------

  /** Todo tickets in the order they start: by priority (urgent first, none last), then your order. */
  private queueOrder(rows: readonly TicketRow[]): Map<string, number> {
    const rank = (p: number) => (p === 0 ? 5 : p);
    const todo = rows.filter((r) => r.status === "todo" && !r.missionId).sort((a, b) => rank(a.priority) - rank(b.priority) || a.position - b.position || a.createdAt - b.createdAt);
    return new Map(todo.map((r, i) => [r.id, i]));
  }

  /** Starts todo tickets while slots are free. One pass at a time; safe to call from anywhere. */
  pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpOnce()).catch((e: Error) => this.deps.log("ticket queue failed", { error: e.message }));
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    for (;;) {
      const active = this.deps.db.select({ id: schema.tickets.id }).from(schema.tickets)
        .where(and(isNotNull(schema.tickets.missionId), inArray(schema.tickets.status, [...OPEN]))).all().length;
      if (active >= this.settings().maxActive) return;
      const rows = this.deps.db.select().from(schema.tickets).where(eq(schema.tickets.status, "todo")).all();
      const order = this.queueOrder(rows);
      const next = rows.filter((r) => order.has(r.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!)[0];
      if (!next) return;
      await this.start(next);
    }
  }

  private async start(t: TicketRow, now = Date.now()): Promise<void> {
    const { missions, projects, db } = this.deps;
    // Marked first, before any await: another pass cannot start it twice.
    db.update(schema.tickets).set({ status: "in_progress", startedAt: now, updatedAt: now }).where(eq(schema.tickets.id, t.id)).run();
    try {
      let projectId = t.projectId;
      if (t.space !== "project") {
        projectId = (await projects.createLocal(SYSTEM, `${keyOf(t)} ${t.title}`.slice(0, 60))).id;
        db.update(schema.tickets).set({ projectId }).where(eq(schema.tickets.id, t.id)).run();
      }
      if (!projectId) throw new Error("Its project no longer exists");
      this.ensureLead(projectId);
      const pictures = this.deps.attachments.list(t.id).length;
      const attached = pictures
        ? `(${pictures} picture${pictures === 1 ? "" : "s"} attached: you see ${pictures === 1 ? "it" : "them"} in this message${t.commitAttachments ? "; they are also in the mission documents folder under request/, commit them with your documents" : ""}.)`
        : "";
      const intent = [t.title, t.description, attached, `(Ticket ${keyOf(t)}${t.external ? `, from ${t.external.key}` : ""})`].filter(Boolean).join("\n\n");
      const m = missions.create(SYSTEM, { projectId, idea: intent, kind: t.kind }, "dashboard", now, { origin: "ticket", title: `${keyOf(t)} ${t.title}` });
      db.update(schema.tickets).set({ missionId: m.id }).where(eq(schema.tickets.id, t.id)).run();
      this.event(t.id, SYSTEM, "started", { missionId: m.id, projectId }, now);
      this.emit(t.id);
    } catch (error) {
      // Nothing started: it goes back to the backlog with the reason, so the queue does not try it forever.
      const reason = (error as Error).message.slice(0, 300);
      db.update(schema.tickets).set({ status: "backlog", startedAt: null, updatedAt: Date.now() }).where(eq(schema.tickets.id, t.id)).run();
      this.event(t.id, SYSTEM, "status", { from: "todo", to: "backlog", reason: `Could not start: ${reason}` });
      this.deps.log("ticket did not start", { ticket: keyOf(t), error: reason });
      this.emit(t.id);
      this.deps.notify?.(this.view(t.id), `could not start: ${reason}`);
    }
  }

  /** A project's missions need a lead; new projects (local ones, freshly registered ones) borrow the standard one. */
  ensureLead(projectId: string): void {
    const { agents } = this.deps;
    if (agents.list(projectId).length) return;
    const template = agents.list().find((a) => a.name.toLowerCase() === "lead") ?? agents.list()[0];
    if (!template) throw new Error("Create a lead agent first (Agents page): new projects copy its model");
    agents.create(SYSTEM, { name: "Lead", projectId, role: template.role, endpointId: template.endpointId, modelId: template.modelId, instructions: template.instructions });
  }

  /** At start: tickets whose start a restart cut short (in progress, no mission) go back to todo. */
  recover(): void {
    this.deps.db.update(schema.tickets).set({ status: "todo", startedAt: null })
      .where(and(eq(schema.tickets.status, "in_progress"), isNull(schema.tickets.missionId))).run();
    for (const t of this.deps.db.select().from(schema.tickets).where(isNotNull(schema.tickets.missionId)).all()) this.sync(this.deps.missions.view(t.missionId!));
    void this.pump();
  }

  // ---- following the mission ---------------------------------------------------------------

  private onLive(msg: LiveMessage): void {
    if (msg.kind === "mission") this.sync(msg.mission);
    // A sub-agent starting or ending changes the "working" count on the card.
    if (msg.kind === "run" && msg.run.missionId) {
      const t = this.byMission(msg.run.missionId);
      if (t) this.emit(t.id);
    }
  }

  private sync(m: MissionView, now = Date.now()): void {
    const t = this.byMission(m.id);
    if (!t || t.status === "canceled" && m.stage !== "done") {
      if (t && m.stage === "cancelled" && !t.endedAt) this.deps.db.update(schema.tickets).set({ endedAt: m.endedAt ?? now }).where(eq(schema.tickets.id, t.id)).run();
      return;
    }
    const status: TicketStatus = m.stage === "done" ? "done" : m.stage === "cancelled" ? "canceled" : needOf(m) ? "needs_you" : "in_progress";
    const need = needOf(m);
    if (status !== t.status) {
      this.deps.db.update(schema.tickets).set({ status, updatedAt: now, ...(status === "done" || status === "canceled" ? { endedAt: m.endedAt ?? now, position: this.topOf(status) } : {}) })
        .where(eq(schema.tickets.id, t.id)).run();
      this.event(t.id, SYSTEM, status === "done" || status === "canceled" ? "ended" : "status", { from: t.status, to: status, ...(need ? { need } : {}) }, now);
    }
    this.emit(t.id);
    const mark = `${status}:${need ?? ""}`;
    if (this.seen.get(t.id) !== mark) {
      const first = !this.seen.has(t.id);
      this.seen.set(t.id, mark);
      // After a restart the current state is learned, not announced again.
      if (!first || status !== t.status) this.announce(this.view(t.id), status, need);
    }
    if (!OPEN.has(status)) void this.pump();
  }

  private announce(t: TicketView, status: TicketStatus, need: TicketNeed | null): void {
    const what = status === "done" ? "is done"
      : status === "canceled" ? "was stopped"
      : need === "answer" ? "has a question for you"
      : need === "approve" ? "has a plan for you to approve"
      : need === "merge" ? "has a pull request for you to merge"
      : need === "failed" ? "stopped and needs you" : null;
    if (what) this.deps.notify?.(t, what);
  }

  // ---- the record --------------------------------------------------------------------------

  event(ticketId: string, actor: string, kind: TicketEventView["kind"], data: Record<string, unknown>, now = Date.now()): void {
    this.deps.db.insert(schema.ticketEvents).values({ ticketId, actor, kind, data, createdAt: now }).run();
  }

  emit(id: string): void {
    this.deps.bus.publish({ kind: "ticket", ticket: this.view(id) });
  }

  private toView(t: TicketRow, queue?: Map<string, number>): TicketView {
    const project = t.projectId ? this.deps.projects.list().find((p) => p.id === t.projectId) ?? null : null;
    let mission: MissionView | null = null;
    if (t.missionId) {
      try {
        mission = this.deps.missions.view(t.missionId);
      } catch {
        mission = null;
      }
    }
    const working = mission ? this.deps.runs.tree(mission.treeId).nodes.filter((n) => n.status === "running").length : 0;
    const order = queue ?? (t.status === "todo" ? this.queueOrder(this.deps.db.select().from(schema.tickets).where(eq(schema.tickets.status, "todo")).all()) : new Map<string, number>());
    const from = t.fromTicketId ? this.deps.db.select().from(schema.tickets).where(eq(schema.tickets.id, t.fromTicketId)).get() : null;
    return {
      id: t.id, key: keyOf(t), space: t.space, projectId: t.projectId, projectName: project?.name ?? null, githubRepo: project?.kind === "github" ? project.githubRepo : null,
      title: t.title, description: t.description, kind: t.kind, priority: t.priority, status: t.status, position: t.position, missionId: t.missionId,
      createdBy: t.createdBy, fromTicket: from ? keyOf(from) : null, commitAttachments: t.commitAttachments, external: t.external,
      attachments: this.deps.attachments.list(t.id), createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, endedAt: t.endedAt,
      stage: mission?.stage ?? null, need: mission && OPEN.has(t.status) ? needOf(mission) : null, costUsd: mission?.costUsd ?? 0, prUrl: mission?.prUrl ?? null,
      working, queuePosition: order.get(t.id) ?? null,
    };
  }

  /** Newest first, at most `limit`: the activity of the board as a whole. */
  recentEvents(limit = 50): TicketEventView[] {
    return this.deps.db.select().from(schema.ticketEvents).orderBy(desc(schema.ticketEvents.id)).limit(limit).all()
      .map((e) => ({ id: e.id, ticketId: e.ticketId, actor: e.actor, kind: e.kind, data: e.data, createdAt: e.createdAt }));
  }
}

/** What a started ticket waits for you to do, if anything. */
export function needOf(m: MissionView): TicketNeed | null {
  if (m.stage === "awaiting_approval") return "approve";
  if (m.stage === "awaiting_merge") return "merge";
  if (!m.waitingForYou) return null;
  return m.leadStatus === "failed" || m.error ? "failed" : "answer";
}
