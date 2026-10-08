/**
 * Global slots for heavy work (commands, builds). Waiters queue FIFO; while the host
 * reports memory pressure, no new slot is handed out.
 */
export class HeavySlots {
  private running = 0;
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    private readonly slots: number,
    private readonly blocked: () => boolean = () => false,
  ) {}

  stats(): { running: number; waiting: number; slots: number } {
    return { running: this.running, waiting: this.waiters.length, slots: this.slots };
  }

  async run<T>(work: () => Promise<T>, opts: { waitMs: number; signal?: AbortSignal }): Promise<T> {
    await this.acquire(opts.waitMs, opts.signal);
    try {
      return await work();
    } finally {
      this.running--;
      this.drain();
    }
  }

  /** Re-check queued waiters (call when pressure clears). */
  drain(): void {
    while (this.waiters.length > 0 && this.running < this.slots && !this.blocked()) {
      const next = this.waiters.shift()!;
      clearTimeout(next.timer);
      this.running++;
      next.resolve();
    }
  }

  private acquire(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (this.waiters.length === 0 && this.running < this.slots && !this.blocked()) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remove(entry);
          reject(new Error(this.blocked() ? "Host is under memory pressure; try again shortly" : "All heavy-task slots are busy; try again shortly"));
        }, waitMs),
      };
      this.waiters.push(entry);
      signal?.addEventListener("abort", () => {
        this.remove(entry);
        clearTimeout(entry.timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
  }

  private remove(entry: (typeof this.waiters)[number]): void {
    const i = this.waiters.indexOf(entry);
    if (i >= 0) this.waiters.splice(i, 1);
  }
}
