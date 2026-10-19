import type { LiveMessage, RunEventType, RunEventView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";

const MAX_STRING = 16 * 1024;

/** Run events go to the database (for replay) and to every live listener (the dashboard). */
export class EventBus {
  private readonly db: Db;
  private readonly listeners = new Set<(msg: LiveMessage) => void>();

  constructor(db: Db) {
    this.db = db;
  }

  subscribe(listener: (msg: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(msg: LiveMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // A broken socket must not stop the run.
      }
    }
  }

  runEvent(runId: string, type: RunEventType, data: Record<string, unknown>, now = Date.now()): RunEventView {
    const clipped = clip(data) as Record<string, unknown>;
    const row = this.db.insert(schema.runEvents).values({ runId, type, data: clipped, createdAt: now }).returning().get();
    const event: RunEventView = { id: row.id, runId, type, data: clipped, createdAt: now };
    this.publish({ kind: "event", event });
    return event;
  }
}

/** Long tool output stays in the workstation; events keep the head and tail. */
export function clip(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING / 2)}\n… ${value.length - MAX_STRING} characters omitted …\n${value.slice(-MAX_STRING / 2)}`;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(clip);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  return value;
}
