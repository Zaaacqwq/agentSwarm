const SMALL = new Set(["a", "an", "and", "of", "the", "to", "in"]);

/** Title Case, keeping small words lowercase except as the first word. */
export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(" ")
    .map((word) => (SMALL.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
