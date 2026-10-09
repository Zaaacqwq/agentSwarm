import { eq, sql } from "drizzle-orm";
import { newId } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";

export const HUMAN_CHAIN_BUDGET = 32;
export const AGENT_CHAIN_BUDGET = 8;

export type ChainRow = typeof schema.chains.$inferSelect;

export type ChargeResult = { ok: true; chain: ChainRow } | { ok: false; chain: ChainRow; justPaused: boolean };

/** Server-owned publication budgets; the model can neither choose nor reset a chain. */
export class ChainStore {
  constructor(private readonly db: Db) {}

  start(orgId: string, originKind: "user" | "agent", originMessageId: number | null, now = Date.now()): ChainRow {
    const budget = originKind === "user" ? HUMAN_CHAIN_BUDGET : AGENT_CHAIN_BUDGET;
    return this.db.insert(schema.chains).values({ id: newId("chn"), orgId, originKind, originMessageId, budget, used: 0, createdAt: now }).returning().get();
  }

  get(id: string): ChainRow | null {
    return this.db.select().from(schema.chains).where(eq(schema.chains.id, id)).get() ?? null;
  }

  /** Spends one publication. Atomic: concurrent agents cannot overshoot the budget. */
  charge(id: string, now = Date.now()): ChargeResult {
    return this.db.transaction((tx) => {
      const chain = tx.select().from(schema.chains).where(eq(schema.chains.id, id)).get();
      if (!chain) throw new Error(`Chain ${id} not found`);
      if (chain.pausedAt) return { ok: false, chain, justPaused: false };
      if (chain.used >= chain.budget) {
        const paused = tx.update(schema.chains).set({ pausedAt: now }).where(eq(schema.chains.id, id)).returning().get()!;
        return { ok: false, chain: paused, justPaused: true };
      }
      const updated = tx.update(schema.chains).set({ used: sql`${schema.chains.used} + 1` }).where(eq(schema.chains.id, id)).returning().get()!;
      return { ok: true, chain: updated };
    });
  }
}
