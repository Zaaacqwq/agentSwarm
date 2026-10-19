import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DesktopSessionView, DesktopView } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { RunRow } from "../agents/run-service.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import { newId } from "../crypto/tokens.ts";
import type { DesktopHelper, HelperStatus } from "./helper.ts";

type Row = typeof schema.desktopSessions.$inferSelect;

/** How long a session may last (R9 plan: default 15 minutes, at most 30). */
export const DEFAULT_MINUTES = 15;
export const MAX_MINUTES = 30;
/** Actions an agent may take between two looks ("look before you act"). */
export const ACTIONS_PER_LOOK = 3;
const POLL_MS = 3_000;
const OPEN = ["queued", "pending", "active"] as const;

export interface DesktopDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly helper: DesktopHelper;
  /** The helper's apps directory: staged apps live in <appsDir>/<runId>. */
  readonly appsDir: string;
  /** Tells a run what happened (it resumes if it waits for the answer). */
  message(runId: string, text: string): void;
  run(runId: string): RunRow;
  projectName(projectId: string): string;
  ticketKey(run: RunRow): string | null;
  /** A note for you, with Approve and Deny when the session waits for you (Discord). */
  notify?(session: DesktopSessionView, what: string, decide: boolean): void;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** What only swarmd and the helper know about an active session: its token, its timer, the agent's looks. */
interface Live {
  readonly token: string;
  readonly timer: NodeJS.Timeout;
  actions: number;
  app: string | null;
}

/**
 * Desktop sessions (R9): one agent at a time tests one app on this Mac's desktop, only after you approve, for a
 * limited time; you can stop it at any moment, here, in Discord or from the menu bar on the Mac.
 */
export class DesktopService {
  private readonly deps: DesktopDeps;
  private readonly live = new Map<string, Live>();
  private status: HelperStatus | null = null;
  private poller: NodeJS.Timeout | null = null;
  private lastView = "";
  /** swarmd is stopping: nothing touches the database any more. */
  private closed = false;
  /** Approvals and endings in progress: a second click, a timer or a poll must not run them twice. */
  private readonly deciding = new Set<string>();
  private readonly ending = new Set<string>();

  constructor(deps: DesktopDeps) {
    this.deps = deps;
  }

  // ---- for you ------------------------------------------------------------------------------

  view(): DesktopView {
    const rows = this.deps.db.select().from(schema.desktopSessions).where(inArray(schema.desktopSessions.status, [...OPEN])).orderBy(asc(schema.desktopSessions.createdAt)).all();
    const order = { active: 0, pending: 1, queued: 2, ended: 3, denied: 3 } as const;
    const s = this.status;
    return {
      helper: { running: Boolean(s), screenRecording: s?.screenRecording ?? false, accessibility: s?.accessibility ?? false, watching: s?.watching ?? false, stoppedByUser: s?.stoppedByUser ?? false },
      sessions: rows.sort((a, b) => order[a.status] - order[b.status]).map((r) => this.toView(r)),
    };
  }

  /** You approve: the helper is armed with a fresh token, and the agent goes on. */
  async approve(actor: string, id: string, now = Date.now()): Promise<DesktopSessionView> {
    if (this.deciding.has(id)) throw conflict("That request is being approved already");
    this.deciding.add(id);
    try {
      const row = this.row(id);
      if (row.status !== "pending") throw conflict(row.status === "queued" ? "Another session has the desktop; this one waits its turn" : "That request is no longer waiting");
      const status = await this.refresh();
      if (!status) throw conflict("agentSwarm Desktop is not running on this Mac: run zsh scripts/setup-desktop.sh");
      if (!status.screenRecording || !status.accessibility) throw conflict("agentSwarm Desktop needs Screen Recording and Accessibility (System Settings → Privacy & Security)");
      if (!status.watching) throw conflict("agentSwarm Desktop cannot yet tell when you use the Mac: run zsh scripts/setup-desktop.sh again to restart it");
      const token = randomBytes(24).toString("hex");
      const until = now + row.minutes * 60_000;
      // Your approval is the confirmation a Stop on the Mac waits for.
      if (status.stoppedByUser) await this.deps.helper.call({ cmd: "ack_stop" });
      await this.deps.helper.call({ cmd: "arm", untilMs: until, holder: row.agent, session: token });
      // Checked again after the waits: it may have been declined or withdrawn meanwhile.
      const claimed = this.deps.db.update(schema.desktopSessions).set({ status: "active", until, decidedAt: now })
        .where(and(eq(schema.desktopSessions.id, id), eq(schema.desktopSessions.status, "pending"))).run();
      if (claimed.changes === 0) {
        await this.deps.helper.call({ cmd: "disarm", session: token }).catch(() => undefined);
        throw conflict("That request is no longer waiting");
      }
      const timer = setTimeout(() => void this.end(id, "its time was up").catch((e: Error) => this.deps.log("desktop expiry failed", { id, error: e.message })), until - now);
      timer.unref();
      this.live.set(id, { token, timer, actions: 0, app: null });
      audit(this.deps.db, actor, "desktop.approve", id, { runId: row.runId, minutes: row.minutes }, now);
      const at = new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      this.tell(row.runId, `The person approved your desktop session: ${row.minutes} minutes, until ${at}. Open the app with desktop_open, look (desktop_look) before you act, and call desktop_release as soon as you are done.`);
      this.changed(this.row(id), "may use the desktop now");
      this.watch();
      return this.toView(this.row(id));
    } finally {
      this.deciding.delete(id);
    }
  }

  deny(actor: string, id: string, now = Date.now()): DesktopSessionView {
    const row = this.row(id);
    if (row.status !== "pending" && row.status !== "queued") throw conflict("That request is no longer waiting");
    this.close(row, "denied", "you declined it", now);
    audit(this.deps.db, actor, "desktop.deny", id, { runId: row.runId }, now);
    this.tell(row.runId, "The person declined your desktop session. Do not ask again for the same thing; report what you could check without it.");
    return this.toView(this.row(id));
  }

  /** Stop: from the dashboard or Discord. Ends whatever is active at once. */
  async stop(actor: string, now = Date.now()): Promise<DesktopView> {
    const active = this.active();
    if (active) {
      audit(this.deps.db, actor, "desktop.stop", active.id, { runId: active.runId }, now);
      await this.end(active.id, "you stopped it", now);
    }
    return this.view();
  }

  // ---- for agents -------------------------------------------------------------------------

  /** A run asks for the desktop. One request per run; it waits for its turn, then for you. */
  request(run: RunRow, agent: string, input: { purpose: string; minutes?: number }, now = Date.now()): DesktopSessionView {
    const purpose = input.purpose.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
    if (purpose.length < 5) throw badRequest("Say what you will test, in a sentence");
    const minutes = Math.round(input.minutes ?? DEFAULT_MINUTES);
    if (minutes < 1 || minutes > MAX_MINUTES) throw badRequest(`A session lasts 1 to ${MAX_MINUTES} minutes`);
    const open = this.forRun(run.id);
    if (open) return this.toView(open);
    const row: Row = {
      id: newId("dsk"), runId: run.id, projectId: run.projectId, agent: agent.slice(0, 40), purpose, minutes,
      status: "queued", until: null, endReason: null, createdAt: now, decidedAt: null, endedAt: null,
    };
    this.deps.db.insert(schema.desktopSessions).values(row).run();
    this.promote();
    this.emit();
    return this.toView(this.row(row.id));
  }

  /** The run's active session and its token, or why it has none. */
  session(runId: string): { row: Row; token: string } {
    const row = this.forRun(runId);
    const live = row && this.live.get(row.id);
    if (!row || row.status !== "active" || !live) {
      throw conflict(row?.status === "pending" || row?.status === "queued" ? "Your desktop session is not approved yet; wait for the person" : "You have no approved desktop session: ask with desktop_request");
    }
    return { row, token: live.token };
  }

  /** Refuses an action when the agent has not looked for a while. */
  mayAct(runId: string): void {
    const { row } = this.session(runId);
    if (this.live.get(row.id)!.actions >= ACTIONS_PER_LOOK) throw conflict(`Look first (desktop_look): at most ${ACTIONS_PER_LOOK} actions between two looks`);
  }

  /** Counts an action that happened. */
  acted(runId: string): void {
    const row = this.forRun(runId);
    const live = row && this.live.get(row.id);
    if (live) live.actions += 1;
  }

  looked(runId: string): void {
    const row = this.forRun(runId);
    const live = row && this.live.get(row.id);
    if (live) live.actions = 0;
  }

  opened(runId: string, app: string): void {
    const row = this.forRun(runId);
    const live = row && this.live.get(row.id);
    if (!live || !row) return;
    live.app = app;
    this.changed(row, `opened ${app}`);
  }

  async release(runId: string, now = Date.now()): Promise<void> {
    const row = this.forRun(runId);
    if (row?.status === "active") await this.end(row.id, "the agent finished", now, false);
    else if (row) this.close(row, "ended", "the agent withdrew it", now);
  }

  /** The run ended (finished, failed, cancelled): its session and its request end with it. */
  async runEnded(runId: string, now = Date.now()): Promise<void> {
    const row = this.forRun(runId);
    if (!row) return;
    // No message: the run is over, and a message would start it again.
    if (row.status === "active") await this.end(row.id, "the agent's run ended", now, false);
    else this.close(row, "ended", "the agent's run ended", now);
  }

  // ---- lifecycle --------------------------------------------------------------------------

  /** At startup nothing is approved any more: the helper is disarmed and leftover sessions end. */
  async start(now = Date.now()): Promise<void> {
    await this.deps.helper.call({ cmd: "disarm" }).catch(() => undefined);
    for (const row of this.deps.db.select().from(schema.desktopSessions).where(inArray(schema.desktopSessions.status, [...OPEN])).all()) {
      this.deps.db.update(schema.desktopSessions).set({ status: "ended", endReason: "swarmd restarted", endedAt: now }).where(eq(schema.desktopSessions.id, row.id)).run();
      // A run that waits for the approval would wait for ever.
      this.tell(row.runId, "Your desktop session ended because agentSwarm restarted. Ask again with desktop_request if you still need it.");
    }
    try {
      for (const name of readdirSync(this.deps.appsDir)) rmSync(join(this.deps.appsDir, name), { recursive: true, force: true });
    } catch {
      // Not installed yet: nothing staged.
    }
    await this.refresh();
  }

  /** swarmd stops: the desktop is handed back (best effort, not awaited). */
  stopAll(): void {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const l of this.live.values()) {
      clearTimeout(l.timer);
      void this.deps.helper.call({ cmd: "disarm", session: l.token }).catch(() => undefined);
    }
  }

  /** Reads the helper; a Stop on the Mac or a lapsed session ends the session here too. */
  async refresh(now = Date.now()): Promise<HelperStatus | null> {
    // A session approved while this status was on its way is not ended by it.
    const before = this.active();
    try {
      this.status = await this.deps.helper.call<HelperStatus & { ok: true }>({ cmd: "status" }, 5_000);
    } catch {
      this.status = null;
    }
    if (this.closed) return this.status;
    const active = this.active();
    if (active && before && active.id === before.id && this.status && !this.status.armed) {
      await this.end(active.id, this.status.stoppedByUser ? "you stopped it on the Mac" : "its time was up", now);
    } else {
      this.emit();
    }
    return this.status;
  }

  /** The helper's pause, for an agent whose input waits while you use the Mac. */
  pausedUntil(): number | null {
    return this.status?.armed?.pausedUntilMs ?? null;
  }

  /** `tell`: the agent learns it lost the desktop (not when it released it, or its run is over). */
  private async end(id: string, reason: string, now = Date.now(), tell = true): Promise<void> {
    if (this.ending.has(id) || this.row(id).status !== "active") return;
    this.ending.add(id);
    try {
      const row = this.row(id);
      const live = this.live.get(id);
      if (live) clearTimeout(live.timer);
      this.live.delete(id);
      // Only with its token: a late end never disarms a newer session.
      if (live) await this.deps.helper.call({ cmd: "disarm", session: live.token }).catch((e: Error) => this.deps.log("desktop disarm failed", { id, error: e.message }));
      // You stopped it on the Mac: the helper keeps refusing until swarmd has ended the session, which it now has.
      if (this.status?.stoppedByUser) await this.deps.helper.call({ cmd: "ack_stop" }).catch(() => undefined);
      rmSync(join(this.deps.appsDir, row.runId), { recursive: true, force: true });
      this.close(row, "ended", reason, now);
      if (tell) this.tell(row.runId, `Your desktop session has ended: ${reason}. The app under test was closed.`);
    } finally {
      this.ending.delete(id);
    }
  }

  /** A note to the run; never to a finished one, which a message would start again. */
  private tell(runId: string, text: string): void {
    try {
      const status = this.deps.run(runId).status;
      if (status === "queued" || status === "running" || status === "waiting") this.deps.message(runId, text);
    } catch (e) {
      this.deps.log("desktop message failed", { runId, error: (e as Error).message });
    }
  }

  /** Ends or denies a session that holds nothing, and lets the next one ask. */
  private close(row: Row, status: "ended" | "denied", reason: string, now: number): void {
    this.deps.db.update(schema.desktopSessions).set({ status, endReason: reason, endedAt: now, ...(row.decidedAt ? {} : { decidedAt: now }) }).where(eq(schema.desktopSessions.id, row.id)).run();
    this.changed(this.row(row.id), status === "denied" ? "was declined" : `ended: ${reason}`);
    this.promote();
  }

  /** When the desktop is free and no one is waiting for you, the oldest queued request asks you. */
  private promote(): void {
    const open = this.deps.db.select().from(schema.desktopSessions).where(inArray(schema.desktopSessions.status, [...OPEN])).orderBy(asc(schema.desktopSessions.createdAt)).all();
    if (open.some((r) => r.status === "active" || r.status === "pending")) return;
    const next = open.find((r) => r.status === "queued");
    if (!next) return;
    this.deps.db.update(schema.desktopSessions).set({ status: "pending" }).where(eq(schema.desktopSessions.id, next.id)).run();
    this.changed(this.row(next.id), "asks to use the desktop", true);
    this.watch();
  }

  /** Polls the helper while anything is open, so a Stop on the Mac and your pauses show up here. */
  private watch(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      if (this.closed || !this.deps.db.select({ id: schema.desktopSessions.id }).from(schema.desktopSessions).where(inArray(schema.desktopSessions.status, ["pending", "active"])).get()) {
        clearInterval(this.poller!);
        this.poller = null;
        return;
      }
      void this.refresh().catch((e: Error) => this.deps.log("desktop status failed", { error: e.message }));
    }, POLL_MS);
    this.poller.unref();
  }

  private changed(row: Row, what: string, decide = false): void {
    this.emit();
    this.deps.notify?.(this.toView(row), what, decide);
  }

  private emit(): void {
    const desktop = this.view();
    const key = JSON.stringify(desktop);
    if (key === this.lastView) return;
    this.lastView = key;
    this.deps.bus.publish({ kind: "desktop", desktop });
  }

  private active(): Row | undefined {
    return this.deps.db.select().from(schema.desktopSessions).where(eq(schema.desktopSessions.status, "active")).get();
  }

  private forRun(runId: string): Row | undefined {
    return this.deps.db.select().from(schema.desktopSessions).where(and(eq(schema.desktopSessions.runId, runId), inArray(schema.desktopSessions.status, [...OPEN]))).get();
  }

  private row(id: string): Row {
    const r = this.deps.db.select().from(schema.desktopSessions).where(eq(schema.desktopSessions.id, id)).get();
    if (!r) throw notFound("No such desktop session");
    return r;
  }

  private toView(r: Row): DesktopSessionView {
    const run = this.deps.run(r.runId);
    const live = this.live.get(r.id);
    return {
      id: r.id, runId: r.runId, runTitle: run.title, agent: r.agent, projectName: this.deps.projectName(r.projectId), ticketKey: this.deps.ticketKey(run),
      purpose: r.purpose, minutes: r.minutes, status: r.status, until: r.until, pausedUntil: r.status === "active" ? this.pausedUntil() : null,
      app: live?.app ?? null, endReason: r.endReason, createdAt: r.createdAt,
    };
  }
}
