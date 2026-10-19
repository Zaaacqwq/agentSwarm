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

/** Common Chinese words that would match nearly anything. */
const CJK_STOP = new Set(["需要", "可以", "进行", "我们", "你们", "他们", "这个", "那个", "一个", "没有", "什么", "因为", "所以", "但是", "如果", "已经", "现在", "时候", "自己", "还是", "就是", "不是", "的话", "问题", "然后", "这样", "一下", "或者", "时间"]);
/** Short words that mean something here. */
const SHORT = new Set(["ui", "ux", "qa", "ci", "go", "js", "ts", "db", "ai", "ml", "ip", "os", "pr", "ai"]);

/** Plurals fold onto the singular ("agents" finds "agent", "fixes" finds "fix"); nothing cleverer. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  const out = new Set<string>();
  const lower = clean(text).toLowerCase();
  for (const run of lower.match(CJK) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) if (!CJK_STOP.has(run.slice(i, i + 2))) out.add(run.slice(i, i + 2));
  }
  for (const w of lower.replace(CJK, " ").match(/[a-z0-9][a-z0-9_.+-]*[a-z0-9+]|[a-z0-9]+/g) ?? []) {
    // "auto-fetch" and "node.js": the whole, and each piece.
    for (const t of new Set([w, ...w.split(/[-.]/)])) {
      if ((t.length >= 3 || SHORT.has(t)) && !STOP.has(t)) out.add(stem(t));
    }
  }
  return [...out];
}

/** Text agents wrote, made safe to show to other agents: no control, invisible or direction-changing characters. */
export function clean(text: string, oneLine = false): string {
  const t = text.normalize("NFKC").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u2028\u2029]|[\u{e0000}-\u{e007f}]/gu, (c) => (c === "\u2028" || c === "\u2029" ? "\n" : ""));
  return oneLine ? t.replace(/\s+/g, " ").trim() : t.replace(/[ \t]+\n/g, "\n").trim();
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

/**
 * The best matches; ties go to the newest. A match needs a title hit or three text hits, and points for a quarter
 * of the query's terms: a long brief must not pull in a lesson for sharing two common words with it.
 */
export function rank<T extends Searchable>(query: string, docs: readonly T[], limit: number): T[] {
  const q = terms(query);
  const min = Math.max(2, Math.ceil(0.25 * Math.min(q.length, 12)));
  return docs.map((d) => ({ d, s: score(q, d), title: q.some((t) => terms(d.title).includes(t)) }))
    .filter((x) => x.s >= min && (x.title || x.s >= 3))
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
export const SECRET = new RegExp([
  String.raw`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}`, String.raw`\b[rs]k_(live|test)_[A-Za-z0-9]{10,}`, String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`, String.raw`\bxox[abprs]-[A-Za-z0-9-]{8,}`, String.raw`\bAKIA[0-9A-Z]{16}\b`, String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`, String.raw`-----BEGIN [A-Z ]*PRIVATE KEY`, String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`,
  String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{20,}`, String.raw`[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@`, String.raw`hooks\.slack\.com/services/`,
  String.raw`\b(secret|token|passw(or)?d|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}`,
].join("|"), "i");

/** Whether text carries any of these values (a project's local files: the real secrets it must never repeat). */
export function carries(text: string, values: readonly string[]): boolean {
  return values.some((v) => v.length >= 8 && text.includes(v));
}
