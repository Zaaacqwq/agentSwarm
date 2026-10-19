import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecEnv } from "./layout.ts";

/**
 * Everything one scope (a run's worktree) may write: the worktree itself, its own HOME and TMPDIR,
 * and the shared package cache. Runs that share a workstation user cannot touch each other's spaces.
 */
export interface Space {
  readonly dir: string;
  readonly home: string;
  readonly tmp: string;
  readonly cache: string;
}

export function space(env: ExecEnv, scope: string): Space {
  const name = scope.replaceAll("/", "__");
  return { dir: join(env.root, scope), home: join(env.root, ".homes", name), tmp: join(env.root, ".tmp", name), cache: join(env.root, "cache") };
}

export function prepareSpace(env: ExecEnv, scope: string): Space {
  const s = space(env, scope);
  for (const d of [s.home, s.tmp, s.cache]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return s;
}
