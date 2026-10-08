/** Counts words case-insensitively, ignoring punctuation. Returns entries sorted by count desc, then word asc. */
export function wordCount(text: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const word of text.split(/\s+/).filter(Boolean)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
