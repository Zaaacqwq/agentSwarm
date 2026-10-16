import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { resolveInScope, resolveScope } from "../paths.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 400;
const SKIP_DIRS = new Set([".git", "node_modules", ".tmp", "dist", "coverage"]);

export function list(env: ExecEnv, scope: string, path: string, depth = 2): { entries: string[]; truncated: boolean } {
  const scopeDir = resolveScope(env.root, scope);
  const start = resolveInScope(scopeDir, path || ".");
  const entries: string[] = [];
  const limit = 500;
  const walk = (dir: string, level: number): void => {
    for (const name of readdirSync(dir).sort()) {
      if (entries.length >= limit) return;
      const full = join(dir, name);
      const isDir = lstatSync(full).isDirectory();
      entries.push(relative(scopeDir, full) + (isDir ? "/" : ""));
      if (isDir && level < depth && !SKIP_DIRS.has(name)) walk(full, level + 1);
    }
  };
  if (!statSync(start).isDirectory()) throw new OpError("bad_request", `${path} is not a directory`);
  walk(start, 1);
  return { entries, truncated: entries.length >= limit };
}

export function read(env: ExecEnv, scope: string, path: string, offset = 1, limit = DEFAULT_READ_LINES) {
  const file = existingFile(env, scope, path);
  const size = statSync(file).size;
  if (size > MAX_READ_BYTES) throw new OpError("bad_request", `${path} is ${size} bytes; too large to read`);
  const lines = readFileSync(file, "utf8").split("\n");
  const from = Math.max(1, offset);
  const slice = lines.slice(from - 1, from - 1 + limit);
  return { path, fromLine: from, totalLines: lines.length, content: slice.join("\n"), truncated: from - 1 + limit < lines.length };
}

export function write(env: ExecEnv, scope: string, path: string, content: string) {
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new OpError("bad_request", "Content too large");
  const file = resolveInScope(resolveScope(env.root, scope), path);
  if (isGitInternal(env, scope, file)) throw new OpError("out_of_scope", "Writing inside .git is not allowed");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return { path, bytes: Buffer.byteLength(content) };
}

export function edit(env: ExecEnv, scope: string, path: string, oldText: string, newText: string, replaceAll = false) {
  if (oldText.length === 0) throw new OpError("bad_request", "oldText must not be empty");
  const file = existingFile(env, scope, path);
  if (isGitInternal(env, scope, file)) throw new OpError("out_of_scope", "Editing inside .git is not allowed");
  const text = readFileSync(file, "utf8");
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new OpError("not_found", "oldText was not found in the file");
  if (count > 1 && !replaceAll) throw new OpError("conflict", `oldText matches ${count} times; add context or set replaceAll`);
  const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
  writeFileSync(file, next);
  return { path, replacements: replaceAll ? count : 1 };
}

export async function grep(env: ExecEnv, scope: string, pattern: string, path = ".", glob?: string, maxResults = 100) {
  const scopeDir = resolveScope(env.root, scope);
  const target = resolveInScope(scopeDir, path);
  const argv = ["/usr/bin/grep", "-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules", ...(glob ? [`--include=${glob}`] : []), "-e", pattern, "--", target];
  const res = await runProcess(env, sandboxed(env, argv), { cwd: scopeDir, timeoutMs: 30_000 });
  if (res.exitCode === 2) throw new OpError("bad_request", res.output.slice(0, 300) || "grep failed");
  const lines = res.output.split("\n").filter(Boolean).map((l) => (l.startsWith(scopeDir) ? l.slice(scopeDir.length + 1) : l));
  return { matches: lines.slice(0, maxResults), truncated: lines.length > maxResults || res.truncated };
}

function existingFile(env: ExecEnv, scope: string, path: string): string {
  const file = resolveInScope(resolveScope(env.root, scope), path);
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new OpError("not_found", `${path} does not exist`);
  }
  if (!st.isFile()) throw new OpError("bad_request", `${path} is not a file`);
  return file;
}

function isGitInternal(env: ExecEnv, scope: string, file: string): boolean {
  const rel = relative(resolveScope(env.root, scope), file);
  return rel === ".git" || rel.startsWith(".git/");
}
