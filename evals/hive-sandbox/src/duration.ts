const UNITS: Record<string, number> = { s: 1, m: 60, h: 360, d: 86_400 };

/** Parses durations like "90s", "5m", "1h30m" into seconds. */
export function parseDuration(text: string): number {
  const parts = text.match(/\d+[smhd]/g);
  if (!parts || parts.join("") !== text) throw new Error(`Invalid duration: ${text}`);
  return parts.reduce((sum, part) => sum + Number(part.slice(0, -1)) * UNITS[part.slice(-1)]!, 0);
}
