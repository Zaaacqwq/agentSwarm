/** Splits items into consecutive chunks of `size`; the last chunk may be shorter. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i + size <= items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
