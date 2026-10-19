import type { ExecEnv } from "./layout.ts";
import { space } from "./space.ts";

/**
 * Seatbelt profile for every command an agent runs. In SBPL the last matching rule wins:
 * deny broad areas first, then re-allow exactly this workstation's own paths. Network is allowed
 * (decision 0004). This is the second wall; the first is the separate OS user on an owned volume.
 */
export function sandboxProfile(env: ExecEnv, scope: string, extraWritable: readonly string[] = []): string {
  const { layout } = env;
  const q = (p: string) => JSON.stringify(p);
  const inbox = `${layout.inbox}/${env.user}.git`;
  // A worktree (worktrees/<project>/<name>) may read its own project's mirror only.
  const project = scope.match(/^worktrees\/([A-Za-z0-9._-]+)\//)?.[1];
  const mirror = project ? `${layout.mirrors}/${project}.git` : null;
  // Only this scope's own space: not the workstation's other worktrees, homes or temp dirs.
  const s = space(env, scope);
  // Extra paths are given only by ws-exec itself (a CLI worker's sign-in), never by a request.
  const writable = [s.dir, s.home, s.tmp, s.cache, inbox, ...extraWritable];
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "/Volumes"))`,
    `(deny file-read* file-write* (regex #"^/Users/[^/]+/"))`,
    `(deny file-read* file-write* (subpath ${q(layout.volume)}))`,
    `(deny file-read* file-write* (subpath ${q(layout.swarmdData)}))`,
    ...writable.map((p) => `(allow file-read* file-write* (subpath ${q(p)}))`),
    ...(mirror ? [`(allow file-read* (subpath ${q(mirror)}))`] : []),
    // Path lookups stat each parent; allow metadata (not listing) on exactly those.
    ...ancestors([...writable, ...(mirror ? [mirror] : [])]).map((d) => `(allow file-read-metadata (literal ${q(d)}))`),
    // Second wall for GUI services (the first is ws-launch's per-user session): clipboard, screen, Apple Events.
    `(deny appleevent-send)`,
    `(deny mach-lookup (global-name "com.apple.pasteboard.1") (global-name-regex #"^com\\.apple\\.windowserver"))`,
    // The dashboard API is not for agents (logins, rate limits, run data).
    `(deny network-outbound (remote ip ${q(`localhost:${layout.swarmdPort}`)}))`,
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

export function sandboxed(env: ExecEnv, argv: readonly string[], scope: string, extraWritable: readonly string[] = []): string[] {
  return env.sandbox ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile(env, scope, extraWritable), ...argv] : [...argv];
}
