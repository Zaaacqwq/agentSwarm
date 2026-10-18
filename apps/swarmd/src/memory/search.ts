/**
 * Literal search for the team's memory (R8): no model call, cheap enough to run at every start and spawn.
 * Words of three or more letters (common ones left out); Chinese, Japanese and Korean runs, which have no spaces,
 * as overlapping pairs of characters. A term in the title counts three, in the text one.
 */

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "has", "have", "had", "not", "but", "you", "your",
  "its", "our", "can", "will", "would", "should", "could", "when", "then", "than", "them", "they", "what", "which", "who", "how", "why",
  "all", "any", "one", "two", "use", "used", "using", "add", "make", "new", "get", "set", "out", "about", "also", "just", "only", "more",
  "most", "some", "such", "each", "other", "there", "here", "where", "been", "being", "does", "did", "done", "very",
]);
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;

/** Plurals fold onto the singular ("agents" finds "agent"); nothing cleverer. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const run of lower.match(CJK) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  for (const w of lower.replace(CJK, " ").match(/[a-z0-9][a-z0-9_.+-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
  }
  return [...out];
}

export interface Searchable {
  readonly title: string;
  readonly text: string;
  readonly updatedAt: number;
}

/** How well a document matches the query's terms: 3 per term in its title, 1 per term only in its text. */
export function score(query: readonly string[], doc: Searchable): number {
  if (!query.length) return 0;
  const title = new Set(terms(doc.title));
  const body = new Set(terms(doc.text));
  let s = 0;
  for (const t of query) s += title.has(t) ? 3 : body.has(t) ? 1 : 0;
  return s;
}

/** The best matches, at least `min` points each; ties go to the newest. */
export function rank<T extends Searchable>(query: string, docs: readonly T[], limit: number, min = 2): T[] {
  const q = terms(query);
  return docs.map((d) => ({ d, s: score(q, d) })).filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s || b.d.updatedAt - a.d.updatedAt).slice(0, limit).map((x) => x.d);
}

/** Two titles say the same thing: most of their terms are shared. */
export function sameIdea(a: string, b: string): boolean {
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / Math.min(x.size, y.size) >= 0.7 && shared / Math.max(x.size, y.size) >= 0.5;
}

/** Text that looks like a credential: refused, never stored. */
export const SECRET = /(sk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
