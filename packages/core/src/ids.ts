export type IdPrefix = "org" | "usr" | "ses" | "ep" | "agt" | "ch" | "run";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
