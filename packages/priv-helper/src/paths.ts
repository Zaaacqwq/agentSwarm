import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OpError } from "./protocol.ts";

const SCOPE_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Validates a scope (a directory relative to the workstation root) and returns its absolute path. */
export function resolveScope(root: string, scope: string): string {
  if (!SCOPE_PATTERN.test(scope) || scope.split("/").some((p) => p === "." || p === "..")) {
    throw new OpError("bad_request", `Invalid scope: ${scope}`);
  }
  return within(realpathSync(root), join(root, scope), "scope");
}

/**
 * Resolves a user-supplied path inside a scope directory. Symlinks are followed on the
 * longest existing prefix, so a link pointing outside the scope is rejected too.
 */
export function resolveInScope(scopeDir: string, path: string): string {
  if (path.includes("\0")) throw new OpError("bad_request", "Path contains NUL");
  if (isAbsolute(path)) throw new OpError("out_of_scope", "Use a path relative to the worktree");
  return within(realpathSync(scopeDir), resolve(scopeDir, path), path);
}

function within(base: string, target: string, label: string): string {
  const real = realExistingPrefix(target);
  const rel = relative(base, real);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return real;
  throw new OpError("out_of_scope", `${label} is outside the allowed directory`);
}

/** realpath of the deepest existing ancestor, with the non-existing tail re-appended. */
function realExistingPrefix(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}
