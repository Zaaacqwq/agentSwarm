/** Exponential backoff delay for a 0-based attempt: base * 2^attempt, capped at max. */
export function backoffDelay(attempt: number, baseMs = 100, maxMs = 10_000): number {
  return Math.min(maxMs, baseMs * (attempt + 1));
}
