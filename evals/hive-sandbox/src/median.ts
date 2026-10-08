/** Median of a non-empty list; for even lengths, the mean of the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of empty list");
  const sorted = [...values].sort();
  return sorted[Math.floor(sorted.length / 2)]!;
}
