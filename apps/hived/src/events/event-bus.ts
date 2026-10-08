import type { ServerEvent } from "@hive/core";

export interface EventEnvelope {
  readonly orgId: string;
  readonly event: ServerEvent;
}

type Listener = (envelope: EventEnvelope) => void;

/** In-process fan-out to WebSocket clients. Listener failures never reach publishers. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  publish(orgId: string, event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ orgId, event });
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
