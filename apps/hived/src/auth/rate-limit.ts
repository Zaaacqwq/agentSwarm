/** Fixed-window counter keyed by caller (for example the client IP on login). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the call is allowed and records it. */
  hit(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      this.prune(now);
      return true;
    }
    if (current.count >= this.limit) return false;
    this.windows.set(key, { start: current.start, count: current.count + 1 });
    return true;
  }

  private prune(now: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}
