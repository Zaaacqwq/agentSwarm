import type { WorkstationBackend, WorkstationSession } from "../workstations/backend.ts";

const COMMAND_TIMEOUT_MS = 90_000;
/** The workstation side ends a session itself after 2 h, or 20 min without a command. */
const SESSION_MS = 2 * 3600_000;

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * One run's headless browser on its workstation (ws-exec's browser.session): commands go out with an id,
 * replies come back as events. Started on the first command; a session that ended starts again on the next.
 */
export class BrowserSession {
  private readonly backend: WorkstationBackend;
  private readonly workstation: string;
  private readonly scope: string;
  private readonly interact: readonly string[];
  private live: { session: WorkstationSession<{ closed: string }>; ready: Promise<void> } | null = null;
  private readonly pending = new Map<number, Pending>();
  private next = 1;

  constructor(backend: WorkstationBackend, workstation: string, scope: string, interact: readonly string[]) {
    this.backend = backend;
    this.workstation = workstation;
    this.scope = scope;
    this.interact = interact;
  }

  private start(): { session: WorkstationSession<{ closed: string }>; ready: Promise<void> } {
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const isReady = new Promise<void>((res, rej) => {
      ready = res;
      failed = rej;
    });
    const session = this.backend.open<{ closed: string }>(this.workstation, { op: "browser.session", scope: this.scope, interact: [...this.interact], timeoutMs: SESSION_MS }, {
      timeoutMs: SESSION_MS + 120_000,
      onEvent: (e) => {
        const ev = e as { ready?: boolean; fatal?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
        if (ev.ready) return ready();
        if (ev.fatal) return failed(new Error(`The browser failed to start: ${ev.fatal}`));
        if (typeof ev.id !== "number") return;
        const p = this.pending.get(ev.id);
        if (!p) return;
        this.pending.delete(ev.id);
        clearTimeout(p.timer);
        if (ev.ok) p.resolve(ev.result);
        else p.reject(new Error(ev.error ?? "The browser command failed"));
      },
    });
    const live = { session, ready: isReady };
    session.done.then(
      (r) => this.ended(live, new Error(`The browser session ended (${r.closed}); the next command starts a new one`)),
      (e: Error) => {
        failed(e);
        this.ended(live, e);
      },
    );
    isReady.catch(() => undefined);
    return live;
  }

  private ended(live: NonNullable<BrowserSession["live"]>, error: Error): void {
    if (this.live === live) this.live = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }

  async command<T>(cmd: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    this.live ??= this.start();
    const live = this.live;
    await live.ready;
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      live.session.send({ id, ...cmd });
    });
  }

  async close(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) return;
    live.session.close();
    await live.session.done.catch(() => undefined);
  }
}
