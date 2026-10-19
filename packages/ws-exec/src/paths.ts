import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OpError } from "./protocol.ts";

const SCOPE_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** A scope is a directory relative to the workstation root; returns its absolute path. */
export function resolveScope(root: string, scope: string): string {
  if (!SCOPE_PATTERN.test(scope) || scope.split("/").some((p) => p === "." || p === "..")) {
    throw new OpError("bad_request", `Invalid scope: ${scope}`);
  }
  return within(realpathSync(root), join(root, scope), "scope");
}

/**
 * A user-supplied path inside a scope. Symlinks are followed on the longest existing prefix,
 * so a link that points outside the scope is rejected too.
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

/** realpath of the deepest existing ancestor, with the missing tail appended. */
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

/**
 * Reads a file a sandboxed command produced in a directory the agent can also write. ws-exec itself runs
 * outside the sandbox, so the file must not be a symlink (to something only the workstation user may read),
 * must be a regular file, and must not be huge.
 */
export function readProduced(path: string, maxBytes = 16 * 1024 * 1024): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new OpError("failed", (error as NodeJS.ErrnoException).code === "ELOOP" ? "Refusing to read a symbolic link" : `The command produced no output file`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new OpError("failed", "The command's output is not a regular file");
    if (st.size > maxBytes) throw new OpError("failed", "The command's output is too large");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
