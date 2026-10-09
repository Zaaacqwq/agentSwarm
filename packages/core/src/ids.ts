export type IdPrefix = "org" | "usr" | "ses" | "ep" | "agt" | "ch" | "run" | "ws" | "repo" | "wt" | "chn";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
