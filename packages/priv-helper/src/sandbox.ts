import type { ExecEnv } from "./layout.ts";

/**
 * Seatbelt profile for every command an agent runs. In SBPL the last matching rule wins:
 * deny broad areas first, then re-allow exactly this workstation's own paths.
 * Network is allowed by decision 0004.
 */
export function sandboxProfile(env: ExecEnv): string {
  const { layout } = env;
  const q = (p: string) => JSON.stringify(p);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "/Volumes"))`,
    `(deny file-read* file-write* (regex #"^/Users/[^/]+/"))`,
    // The whole workstation volume (other workstations, hived data, inboxes) is closed by default.
    `(deny file-read* file-write* (subpath ${q(layout.volume)}))`,
    `(deny file-read* file-write* (subpath ${q(layout.hivedData)}))`,
    `(allow file-read* file-write* (subpath ${q(env.home)}))`,
    `(allow file-read* file-write* (subpath ${q(env.root)}))`,
    `(allow file-read* (subpath ${q(layout.mirrors)}))`,
    `(allow file-read* file-write* (subpath ${q(`${layout.inbox}/${env.user}.git`)}))`,
    // Path lookups stat each parent directory; allow metadata (not listing) on exactly those.
    ...ancestors([env.root, env.home, layout.mirrors, `${layout.inbox}/${env.user}.git`]).map((d) => `(allow file-read-metadata (literal ${q(d)}))`),
  ].join("\n");
}

function ancestors(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    let current = p;
    while (current !== "/" && current !== "") {
      current = current.slice(0, current.lastIndexOf("/")) || "/";
      out.add(current);
    }
  }
  return [...out].sort();
}

export function sandboxed(env: ExecEnv, argv: readonly string[]): string[] {
  return env.sandbox ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile(env), ...argv] : [...argv];
}
