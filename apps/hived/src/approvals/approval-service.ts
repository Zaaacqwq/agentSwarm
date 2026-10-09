import { and, desc, eq, gt, lte } from "drizzle-orm";
import { newId, type Approval, type ApprovalKind, type ApprovalQuery, type DecideApproval } from "@hive/core";
import type { AgentContext } from "@hive/tools";
import type { AuthUser } from "../auth/auth-service.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { EventBus } from "../events/event-bus.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, forbidden, notFound } from "../http/errors.ts";

type Row = typeof schema.approvals.$inferSelect;

/** How long a request waits for a person before it lapses. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_SESSION_MS: Record<Exclude<ApprovalKind, "question">, number> = {
  desktop: 15 * 60 * 1000,
  browser_site: 30 * 60 * 1000,
};
export const MAX_SESSION_MS = 60 * 60 * 1000;
/** Requests one agent may make per hour, so a looping agent cannot flood people with cards. */
export const MAX_REQUESTS_PER_HOUR = 20;
/** After a person declines a session approval, the same request is refused without asking again. */
export const DENIAL_COOLDOWN_MS = 10 * 60 * 1000;

export interface ApprovalRequest {
  readonly kind: ApprovalKind;
  /** Host for browser_site, "console" for desktop; ignored for questions. */
  readonly scope?: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly durationMs?: number;
}

export interface ApprovalDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly postCard: (orgId: string, channelId: string, body: string, runId: string | null) => { id: number };
  readonly canReadChannel: (user: AuthUser, channelId: string) => boolean;
  readonly agentName: (agentId: string) => string;
  readonly onWaiting?: (agentId: string, reason: string | null) => void;
  /** Called after a session approval ends early (revoked) so holders can be stopped. */
  readonly onSessionEnded?: (row: Row) => void;
  readonly timeoutMs?: number;
}

/**
 * Human-in-the-loop decisions. Agents block on request(); people answer through the UI.
 * Session approvals (desktop, browser_site) stay valid until expires_at and are reused.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Set<(row: Row) => void>>();

  constructor(private readonly deps: ApprovalDeps) {}

  /** Resolves with the final row: approved, denied, expired or cancelled. */
  async request(ctx: AgentContext, input: ApprovalRequest, now = Date.now()): Promise<Row> {
    const scope = input.kind === "question" ? "" : (input.scope ?? "").toLowerCase();
    if (input.kind !== "question") {
      const active = this.active(ctx.agentId, input.kind, scope, now);
      if (active) return active;
    }
    const pending = input.kind === "question" ? undefined : this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, ctx.agentId), eq(schema.approvals.kind, input.kind), eq(schema.approvals.scope, scope), eq(schema.approvals.status, "pending"))).get();
    if (!pending) {
      if (input.kind !== "question") {
        const denied = this.deps.db.select().from(schema.approvals)
          .where(and(eq(schema.approvals.agentId, ctx.agentId), eq(schema.approvals.kind, input.kind), eq(schema.approvals.scope, scope), eq(schema.approvals.status, "denied"), gt(schema.approvals.decidedAt, now - DENIAL_COOLDOWN_MS)))
          .orderBy(desc(schema.approvals.decidedAt)).get();
        if (denied) return denied;
      }
      const recent = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
        .where(and(eq(schema.approvals.agentId, ctx.agentId), gt(schema.approvals.createdAt, now - 60 * 60 * 1000))).all().length;
      if (recent >= MAX_REQUESTS_PER_HOUR) throw new Error("You have asked people too many times this hour; continue without it or wait.");
    }
    const row = pending ?? this.create(ctx, { ...input, scope }, now);
    return this.wait(row, ctx);
  }

  private create(ctx: AgentContext, input: ApprovalRequest & { scope: string }, now: number): Row {
    const channelId = ctx.trigger?.humanChannelIds[0] ?? ctx.trigger?.channelIds[0] ?? null;
    const duration = input.kind === "question" ? null : Math.min(input.durationMs ?? DEFAULT_SESSION_MS[input.kind], MAX_SESSION_MS);
    const row = this.deps.db.insert(schema.approvals).values({
      id: newId("apr"), orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, channelId, messageId: null,
      kind: input.kind, scope: input.scope, question: input.question.slice(0, 2000), options: (input.options ?? []).slice(0, 6).map((o) => o.slice(0, 80)),
      status: "pending", answer: null, durationMs: duration, decidedBy: null, decidedAt: null,
      timeoutAt: now + (this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS), expiresAt: null, createdAt: now,
    }).returning().get();
    let messageId: number | null = null;
    if (channelId) {
      try {
        messageId = this.deps.postCard(ctx.orgId, channelId, cardText(row, this.deps.agentName(ctx.agentId)), ctx.runId).id;
      } catch {
        // The card is a convenience; the pending list in the UI still shows the request.
      }
    }
    const saved = messageId === null ? row : this.deps.db.update(schema.approvals).set({ messageId }).where(eq(schema.approvals.id, row.id)).returning().get()!;
    writeAudit(this.deps.db, { orgId: ctx.orgId, actorKind: "agent", actorId: ctx.agentId, action: "approval.requested", targetId: row.id, metadata: { kind: row.kind, scope: row.scope } }, now);
    this.publish(saved);
    return saved;
  }

  private wait(row: Row, ctx: AgentContext): Promise<Row> {
    // Shown as "<Agent> is waiting for …".
    const name = row.kind === "question" ? "an answer" : "approval";
    this.deps.onWaiting?.(ctx.agentId, `${name}: ${row.question.slice(0, 80)}`);
    return new Promise<Row>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (final: Row): void => {
        if (timer) clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        this.detach(row.id, finish);
        this.deps.onWaiting?.(ctx.agentId, null);
        resolve(final);
      };
      // A stopped turn withdraws the request only if nobody else is still waiting on it.
      const onAbort = (): void => {
        const others = [...(this.waiters.get(row.id) ?? [])].filter((f) => f !== finish);
        if (others.length > 0) return finish({ ...this.row(row.id)!, status: "cancelled" });
        this.close(row.id, "cancelled");
      };
      const set = this.waiters.get(row.id) ?? new Set();
      set.add(finish);
      this.waiters.set(row.id, set);
      if (ctx.signal?.aborted) return onAbort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => this.close(row.id, "expired"), Math.max(0, row.timeoutAt - Date.now()));
    });
  }

  private detach(id: string, finish: (row: Row) => void): void {
    const set = this.waiters.get(id);
    set?.delete(finish);
    if (set?.size === 0) this.waiters.delete(id);
  }

  /** Ends a still-pending request without a decision and releases everyone waiting on it. */
  private close(id: string, status: "expired" | "cancelled", now = Date.now()): Row {
    const row = this.deps.db.update(schema.approvals).set({ status, decidedAt: now })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending"))).returning().get();
    if (row) this.publish(row);
    const final = row ?? this.row(id)!;
    for (const finish of [...(this.waiters.get(id) ?? [])]) finish(final);
    return final;
  }

  decide(user: AuthUser, id: string, input: DecideApproval, now = Date.now()): Approval {
    const row = this.visibleRow(user, id);
    if (row.kind !== "question" && user.role !== "admin") throw forbidden("Only admins can approve desktop or browser access");
    if (row.status !== "pending") throw badRequest(`This request is already ${row.status}`);
    if (row.kind === "question" && input.decision === "approve" && !input.answer?.trim() && row.options.length > 0) throw badRequest("Pick an option or write an answer");
    const approve = input.decision === "approve";
    const duration = input.minutes ? input.minutes * 60_000 : row.durationMs;
    const updated = this.deps.db.update(schema.approvals).set({
      status: approve ? "approved" : "denied",
      answer: input.answer?.trim().slice(0, 2000) || null,
      decidedBy: user.username,
      decidedAt: now,
      durationMs: duration,
      expiresAt: approve && duration ? now + Math.min(duration, MAX_SESSION_MS) : null,
    }).where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending"))).returning().get();
    if (!updated) throw badRequest("This request was already settled");
    writeAudit(this.deps.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: approve ? "approval.approved" : "approval.denied", targetId: id, metadata: { kind: row.kind, scope: row.scope, durationMs: updated.durationMs } }, now);
    this.publish(updated);
    for (const finish of [...(this.waiters.get(id) ?? [])]) finish(updated);
    return this.toApproval(updated);
  }

  /** Ends an approved session early (the "stop" button). */
  revoke(user: AuthUser | null, id: string, now = Date.now()): Approval {
    const row = user ? this.visibleRow(user, id) : this.row(id);
    if (!row) throw notFound("Approval");
    if (user && row.kind !== "question" && user.role !== "admin") throw forbidden("Only admins can revoke access");
    if (row.status === "pending") return this.toApproval(this.close(id, "cancelled", now));
    if (row.status !== "approved" || !row.expiresAt || row.expiresAt <= now) throw badRequest("This approval is not active");
    const updated = this.deps.db.update(schema.approvals).set({ status: "revoked", expiresAt: now }).where(eq(schema.approvals.id, id)).returning().get()!;
    writeAudit(this.deps.db, { orgId: row.orgId, actorKind: user ? "user" : "system", actorId: user?.id ?? null, action: "approval.revoked", targetId: id, metadata: { kind: row.kind, scope: row.scope } }, now);
    this.publish(updated);
    this.deps.onSessionEnded?.(updated);
    return this.toApproval(updated);
  }

  /** The agent's live session approval for a kind and scope, if any. */
  active(agentId: string, kind: Exclude<ApprovalKind, "question">, scope: string, now = Date.now()): Row | null {
    return this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.kind, kind), eq(schema.approvals.scope, scope.toLowerCase()), eq(schema.approvals.status, "approved"), gt(schema.approvals.expiresAt, now)))
      .orderBy(desc(schema.approvals.expiresAt)).get() ?? null;
  }

  /** Every live session approval of a kind, across agents. */
  activeOfKind(kind: Exclude<ApprovalKind, "question">, now = Date.now()): Row[] {
    return this.deps.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.kind, kind), eq(schema.approvals.status, "approved"), gt(schema.approvals.expiresAt, now))).all();
  }

  /** Hosts this agent may currently submit to in its browser, each with its expiry. */
  approvedHosts(agentId: string, now = Date.now()): { host: string; until: number }[] {
    return this.deps.db.select({ scope: schema.approvals.scope, until: schema.approvals.expiresAt }).from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.kind, "browser_site"), eq(schema.approvals.status, "approved"), gt(schema.approvals.expiresAt, now)))
      .all().map((r) => ({ host: r.scope, until: r.until! }));
  }

  list(user: AuthUser, query: ApprovalQuery, now = Date.now()): Approval[] {
    const conds = [eq(schema.approvals.orgId, user.orgId)];
    if (query.channelId) conds.push(eq(schema.approvals.channelId, query.channelId));
    if (query.agentId) conds.push(eq(schema.approvals.agentId, query.agentId));
    if (query.status === "active") conds.push(eq(schema.approvals.status, "approved"), gt(schema.approvals.expiresAt, now));
    else if (query.status) conds.push(eq(schema.approvals.status, query.status));
    return this.deps.db.select().from(schema.approvals).where(and(...conds)).orderBy(desc(schema.approvals.createdAt)).limit(user.role === "admin" ? 200 : 2000).all()
      .filter((r) => this.canSee(user, r)).slice(0, 200).map((r) => this.toApproval(r));
  }

  /** After a restart nobody is waiting on old requests; they lapse. */
  expireStale(now = Date.now()): void {
    this.deps.db.update(schema.approvals).set({ status: "expired", decidedAt: now }).where(eq(schema.approvals.status, "pending")).run();
  }

  /** Pending requests whose deadline passed while no waiter held them (e.g. after a crash). */
  sweep(now = Date.now()): void {
    const stale = this.deps.db.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.status, "pending"), lte(schema.approvals.timeoutAt, now))).all().map((r) => r.id);
    for (const id of stale) if (!this.waiters.has(id)) this.close(id, "expired", now);
  }

  get(user: AuthUser, id: string): Approval {
    return this.toApproval(this.visibleRow(user, id));
  }

  row(id: string): Row | null {
    return this.deps.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get() ?? null;
  }

  private visibleRow(user: AuthUser, id: string): Row {
    const row = this.row(id);
    if (!row || row.orgId !== user.orgId || !this.canSee(user, row)) throw notFound("Approval");
    return row;
  }

  private canSee(user: AuthUser, row: Row): boolean {
    if (user.role === "admin") return true;
    return row.channelId !== null && this.deps.canReadChannel(user, row.channelId);
  }

  private publish(row: Row): void {
    this.deps.bus.publish(row.orgId, { type: "approval.updated", approval: this.toApproval(row) }, row.channelId ? { channelId: row.channelId } : undefined);
  }

  toApproval(row: Row): Approval {
    return {
      id: row.id, agentId: row.agentId, agentName: this.deps.agentName(row.agentId), runId: row.runId, channelId: row.channelId, messageId: row.messageId,
      kind: row.kind, scope: row.scope, question: row.question, options: row.options, status: row.status, answer: row.answer, durationMs: row.durationMs,
      decidedBy: row.decidedBy, decidedAt: row.decidedAt, timeoutAt: row.timeoutAt, expiresAt: row.expiresAt, createdAt: row.createdAt,
    };
  }
}

/** Plain-text body for the chat message the card is rendered on (also what agents read). */
function cardText(row: Row, agent: string): string {
  const head = row.kind === "desktop" ? `🔐 ${agent} asks to control this Mac's desktop for ${Math.round((row.durationMs ?? 0) / 60000)} min`
    : row.kind === "browser_site" ? `🔐 ${agent} asks to submit forms on ${row.scope} for ${Math.round((row.durationMs ?? 0) / 60000)} min`
    : `❓ ${agent} asks`;
  const options = row.options.length ? `\nOptions: ${row.options.join(" / ")}` : "";
  return `${head}: ${row.question}${options}`;
}
