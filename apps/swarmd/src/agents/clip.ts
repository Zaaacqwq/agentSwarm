import type { TSchema } from "@earendil-works/pi-ai";

const NOTE = (cut: number) => `\n…[${cut} characters cut: over the limit]`;

function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  const note = NOTE(value.length - max);
  // A short limit has no room for the note: cut plainly.
  return note.length * 4 > max ? value.slice(0, max) : value.slice(0, max - note.length) + note;
}

/**
 * A `prepareArguments` that shortens over-long text fields (top level, and strings in arrays) to the
 * schema's maxLength instead of letting validation reject the call. A model that is told "too long"
 * often resends the same text, paying for its whole context each time; cutting the tail is cheaper.
 */
export function clipToSchema(schema: TSchema): (args: unknown) => any {
  const limits = Object.entries((schema as { properties?: Record<string, unknown> }).properties ?? {}).flatMap(([key, prop]: [string, any]) => {
    if (prop.type === "string" && prop.maxLength) return [{ key, max: prop.maxLength as number, array: false }];
    if (prop.type === "array" && prop.items?.type === "string" && prop.items.maxLength) return [{ key, max: prop.items.maxLength as number, array: true }];
    return [];
  });
  return (args) => {
    if (!args || typeof args !== "object") return args;
    const a = args as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const { key, max, array } of limits) {
      const v = a[key];
      if (!array && typeof v === "string" && v.length > max) changed[key] = clipText(v, max);
      if (array && Array.isArray(v) && v.some((s) => typeof s === "string" && s.length > max)) changed[key] = v.map((s) => (typeof s === "string" ? clipText(s, max) : s));
    }
    return Object.keys(changed).length ? { ...a, ...changed } : args;
  };
}
