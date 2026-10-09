import type { ServerEvent } from "@hive/core";

/** Who may receive an event beyond org membership. Without an audience, the whole org sees it. */
export interface Audience {
  /** Only people who can read this channel (members, or anyone in the org for agent DMs). */
  readonly channelId?: string;
  /** Only these users (e.g. the members of a channel that no longer exists). */
  readonly userIds?: readonly string[];
}

export interface EventEnvelope {
  readonly orgId: string;
  readonly event: ServerEvent;
  readonly audience?: Audience;
}

type Listener = (envelope: EventEnvelope) => void;

/** In-process fan-out to WebSocket clients. Listener failures never reach publishers. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  publish(orgId: string, event: ServerEvent, audience?: Audience): void {
    for (const listener of this.listeners) {
      try {
        listener(audience ? { orgId, event, audience } : { orgId, event });
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
