/** Cheap last-line check on added lines; not a substitute for GitHub secret scanning. */
const PATTERNS: readonly [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ["OpenAI/OpenRouter-style key", /\bsk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

export function scanAddedLines(diff: string): string[] {
  const hits = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const [label, re] of PATTERNS) if (re.test(line)) hits.add(label);
  }
  return [...hits];
}
