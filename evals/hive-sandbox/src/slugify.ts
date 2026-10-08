/** URL slug: lowercase words joined by single hyphens, no leading or trailing hyphen. */
export function slugify(text: string): string {
  return text.trim().replace(/[^A-Za-z0-9]+/g, "-");
}
