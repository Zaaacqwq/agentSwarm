import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId, type ActivityEvent, type ActivityKind, type Run, type RunStatus, type UsageSummary } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";

type RunRow = typeof schema.runs.$inferSelect;

export interface UsageInput {
  readonly orgId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly endpointId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

/** Persistence for runs, their activity, usage, and Pi session checkpoints. */
export class RunStore {
  constructor(private readonly db: Db) {}

  createQueued(orgId: string, agentId: string, triggerMessageIds: number[], now = Date.now()): Run {
    const row = this.db.insert(schema.runs)
      .values({ id: newId("run"), orgId, agentId, status: "queued", triggerMessageIds, createdAt: now })
      .returning().get();
    return toRun(row);
  }

  get(runId: string): Run | null {
    const row = this.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    return row ? toRun(row) : null;
  }

  orgOf(runId: string): string | null {
    return this.db.select({ o: schema.runs.orgId }).from(schema.runs).where(eq(schema.runs.id, runId)).get()?.o ?? null;
  }

  findQueued(agentId: string): Run | null {
    const row = this.db.select().from(schema.runs)
      .where(and(eq(schema.runs.agentId, agentId), eq(schema.runs.status, "queued")))
      .orderBy(asc(schema.runs.createdAt)).limit(1).get();
    return row ? toRun(row) : null;
  }

  /** Whether a queued or running run was woken by a message in this channel. */
  hasPendingWorkIn(channelId: string): boolean {
    const active = this.db.select().from(schema.runs).where(inArray(schema.runs.status, ["queued", "running"])).all();
    const ids = active.flatMap((r) => r.triggerMessageIds);
    if (ids.length === 0) return false;
    return !!this.db.select({ id: schema.messages.id }).from(schema.messages)
      .where(and(inArray(schema.messages.id, ids), eq(schema.messages.channelId, channelId))).limit(1).get();
  }

  listQueued(): Run[] {
    return this.db.select().from(schema.runs).where(eq(schema.runs.status, "queued")).orderBy(asc(schema.runs.createdAt)).all().map(toRun);
  }

  appendTrigger(runId: string, messageId: number): Run {
    const run = this.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const ids = run.triggerMessageIds.includes(messageId) ? run.triggerMessageIds : [...run.triggerMessageIds, messageId];
    const row = this.db.update(schema.runs).set({ triggerMessageIds: ids }).where(eq(schema.runs.id, runId)).returning().get();
    return toRun(row);
  }

  markRunning(runId: string, now = Date.now()): Run {
    const row = this.db.update(schema.runs).set({ status: "running", startedAt: now })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, "queued"))).returning().get();
    if (!row) throw new Error(`Run ${runId} is not queued`);
    return toRun(row);
  }

  finish(runId: string, status: Extract<RunStatus, "succeeded" | "failed" | "interrupted">, error: string | null, now = Date.now()): Run {
    const row = this.db.update(schema.runs).set({ status, error, finishedAt: now }).where(eq(schema.runs.id, runId)).returning().get();
    if (!row) throw new Error(`Run ${runId} not found`);
    return toRun(row);
  }

  /** On boot: runs that were mid-flight are interrupted (never replayed); queued runs are returned to reschedule. */
  recover(now = Date.now()): { interrupted: Run[]; queued: Run[] } {
    const interrupted = this.db.update(schema.runs)
      .set({ status: "interrupted", error: "Hive restarted during this run", finishedAt: now })
      .where(eq(schema.runs.status, "running")).returning().all().map(toRun);
    return { interrupted, queued: this.listQueued() };
  }

  addActivity(run: Pick<Run, "id" | "agentId">, kind: ActivityKind, payload: Record<string, unknown>, now = Date.now()): ActivityEvent {
    const row = this.db.insert(schema.activityEvents)
      .values({ runId: run.id, agentId: run.agentId, kind, payload, createdAt: now }).returning().get();
    return { id: row.id, runId: row.runId, agentId: row.agentId, kind: row.kind, payload: row.payload, createdAt: row.createdAt };
  }

  addUsage(input: UsageInput, now = Date.now()): Run {
    return this.db.transaction((tx) => {
      tx.insert(schema.usageRecords).values({ ...input, createdAt: now }).run();
      const row = tx.update(schema.runs).set({
        inputTokens: sql`${schema.runs.inputTokens} + ${input.inputTokens}`,
        outputTokens: sql`${schema.runs.outputTokens} + ${input.outputTokens}`,
        cacheReadTokens: sql`${schema.runs.cacheReadTokens} + ${input.cacheReadTokens}`,
        cacheWriteTokens: sql`${schema.runs.cacheWriteTokens} + ${input.cacheWriteTokens}`,
        costUsd: sql`${schema.runs.costUsd} + ${input.costUsd}`,
      }).where(eq(schema.runs.id, input.runId)).returning().get();
      if (!row) throw new Error(`Run ${input.runId} not found`);
      return toRun(row);
    });
  }

  listRuns(orgId: string, agentId: string, limit = 30): Run[] {
    return this.db.select().from(schema.runs)
      .where(and(eq(schema.runs.orgId, orgId), eq(schema.runs.agentId, agentId)))
      .orderBy(desc(schema.runs.createdAt)).limit(limit).all().map(toRun);
  }

  listActivity(runIds: readonly string[]): ActivityEvent[] {
    if (runIds.length === 0) return [];
    return this.db.select().from(schema.activityEvents)
      .where(inArray(schema.activityEvents.runId, [...runIds])).orderBy(asc(schema.activityEvents.id)).all()
      .map((r) => ({ id: r.id, runId: r.runId, agentId: r.agentId, kind: r.kind, payload: r.payload, createdAt: r.createdAt }));
  }

  usageSummary(orgId: string, agentId?: string): UsageSummary {
    const where = agentId
      ? and(eq(schema.usageRecords.orgId, orgId), eq(schema.usageRecords.agentId, agentId))
      : eq(schema.usageRecords.orgId, orgId);
    const row = this.db.select({
      inputTokens: sql<number>`coalesce(sum(${schema.usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${schema.usageRecords.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${schema.usageRecords.costUsd}), 0)`,
      runs: sql<number>`count(distinct ${schema.usageRecords.runId})`,
    }).from(schema.usageRecords).where(where).get();
    return row ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
  }

  loadSession(agentId: string): unknown[] | null {
    return this.db.select({ e: schema.agentSessions.entries }).from(schema.agentSessions).where(eq(schema.agentSessions.agentId, agentId)).get()?.e ?? null;
  }

  saveSession(agentId: string, entries: unknown[], now = Date.now()): void {
    this.db.insert(schema.agentSessions).values({ agentId, entries, updatedAt: now })
      .onConflictDoUpdate({ target: schema.agentSessions.agentId, set: { entries, updatedAt: now } }).run();
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    error: row.error,
    triggerMessageIds: row.triggerMessageIds,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
