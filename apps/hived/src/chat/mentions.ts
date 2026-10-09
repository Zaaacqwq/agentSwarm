export interface Mentionable {
  readonly id: string;
  readonly name: string;
}

export interface ParsedMentions {
  readonly ids: string[];
  readonly all: boolean;
}

const ALL = ["all", "everyone"];

/**
 * Finds @mentions of the given candidates. Longest names match first so "@Ada Lovelace"
 * beats "@Ada"; a mention must end at whitespace, punctuation or the end of the text.
 */
export function parseMentions(body: string, candidates: readonly Mentionable[]): ParsedMentions {
  const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
  const ids = new Set<string>();
  let all = false;
  const lower = body.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && /[\p{L}\p{N}_]/u.test(lower[i - 1]!)) continue; // e.g. an email address
    const rest = lower.slice(i + 1);
    const allWord = ALL.find((w) => rest.startsWith(w) && boundary(rest, w.length));
    if (allWord) {
      all = true;
      continue;
    }
    const hit = sorted.find((c) => rest.startsWith(c.name.toLowerCase()) && boundary(rest, c.name.length));
    if (hit) ids.add(hit.id);
  }
  return { ids: [...ids], all };
}

function boundary(text: string, at: number): boolean {
  const next = text[at];
  return next === undefined || !/[\p{L}\p{N}_-]/u.test(next);
}
