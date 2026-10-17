import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { resolveInScope, resolveScope } from "../paths.ts";
import { prepareSpace, space } from "../space.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";

/** swarm/<project>/<part>[/<sub-part>...]: one segment per level of the agent tree (R2). */
export const BRANCH_PATTERN = /^swarm\/[a-z0-9][a-z0-9-]{0,39}(\/[a-z0-9][a-z0-9-]{0,59}){1,4}$/;
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const WORKTREE_SCOPE = /^worktrees\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const AUTHOR = { name: "agentSwarm Agent", email: "agent@agentswarm.local" };

async function git(env: ExecEnv, cwd: string, args: string[], stdin?: string, timeoutMs = 120_000, scope?: string) {
  // Calls without a scope work on the inbox only; give them a space of their own.
  const sc = scope ?? ".inbox";
  return runProcess(env, sandboxed(env, ["/usr/bin/git", ...args], sc), { cwd, scope: sc, timeoutMs, ...(stdin !== undefined ? { stdin } : {}) });
}

function ok<T extends { exitCode: number | null; output: string }>(res: T, what: string): T {
  if (res.exitCode !== 0) throw new OpError("failed", `${what} failed: ${res.output.trim().slice(-800)}`);
  return res;
}

function inboxPath(env: ExecEnv): string {
  return `${env.layout.inbox}/${env.user}.git`;
}

const MAX_FILES = 20;
const SEGMENT = /^[A-Za-z0-9._@+ -]{1,100}$/;

/**
 * A project file path: relative, segments of safe characters, no "." / ".." / empty segments, and no
 * ".git" segment in any case (APFS is case-insensitive). Mirrors projectFilePath in swarmd.
 */
export function projectFilePath(path: unknown): string | null {
  if (typeof path !== "string" || path.length < 1 || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.some((p) => !SEGMENT.test(p) || p === "." || p === ".." || p.toLowerCase() === ".git" || p.trim() !== p)) return null;
  return parts.join("/");
}

/** Refuses a path whose existing parts include a symlink: nothing may redirect where a file lands. */
function noLinks(root: string, rel: string): void {
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    if (!existsSync(cur)) return;
    if (lstatSync(cur).isSymbolicLink()) throw new OpError("out_of_scope", `${rel} goes through a symbolic link`);
  }
}

/** Appends to a file without following a symlink at any step (the agent controls its own .git). */
function appendNoFollow(root: string, rel: string, text: string): void {
  noLinks(root, rel);
  const fd = openSync(join(root, rel), fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * The project's local files (Local.xcconfig, .env): written into the worktree and listed in
 * .git/info/exclude so `git add -A` never picks them up. The Relay refuses them in a push too.
 */
function placeFiles(dir: string, files: readonly { path: string; content: string }[] | undefined): number {
  if (!files?.length) return 0;
  if (files.length > MAX_FILES) throw new OpError("bad_request", `At most ${MAX_FILES} files`);
  noLinks(dir, ".git/info");
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  noLinks(dir, ".git/info/exclude");
  const excludeFile = join(dir, ".git", "info", "exclude");
  const excluded = new Set((existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "").split("\n"));
  for (const f of files) {
    const path = projectFilePath(f.path);
    if (!path || typeof f.content !== "string") throw new OpError("bad_request", `Invalid file ${String(f.path)}`);
    noLinks(dir, path);
    const target = resolveInScope(dir, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    noLinks(dir, path);
    const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, f.content);
    } finally {
      closeSync(fd);
    }
    const line = `/${path}`;
    if (!excluded.has(line)) {
      appendNoFollow(dir, ".git/info/exclude", `${line}\n`);
      excluded.add(line);
    }
  }
  return files.length;
}

export async function clone(env: ExecEnv, scope: string, mirror: string, branch: string, base: string, author = AUTHOR, files?: readonly { path: string; content: string }[]) {
  if (!WORKTREE_SCOPE.test(scope)) throw new OpError("bad_request", "Worktrees live at worktrees/<repo>/<name>");
  if (!BRANCH_PATTERN.test(branch)) throw new OpError("bad_request", `Branch must look like swarm/<project>/<part>: ${branch}`);
  if (!BASE_PATTERN.test(base) || base.includes("..")) throw new OpError("bad_request", "Invalid base branch");
  const mirrorPath = checkMirror(env, mirror);
  const parent = join(env.root, dirname(scope));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = resolveScope(env.root, dirname(scope)) + "/" + scope.split("/").pop();
  if (existsSync(dir)) {
    // A run that failed after cloning comes back to the same worktree.
    const current = await git(env, dir, ["rev-parse", "--abbrev-ref", "HEAD"], undefined, 30_000, scope);
    if (existsSync(join(dir, ".git")) && current.exitCode === 0 && current.output.trim() === branch) {
      const head = ok(await git(env, dir, ["rev-parse", "HEAD"], undefined, 30_000, scope), "rev-parse").output.trim();
      return { scope, branch, head, resumed: true, files: placeFiles(dir, files) };
    }
    throw new OpError("conflict", `Worktree ${scope} already exists on another branch`);
  }

  // Run from the scope's own home: the sandbox does not let it look at the shared parent directory.
  ok(await git(env, prepareSpace(env, scope).home, ["clone", "--quiet", "--no-hardlinks", "--branch", base, mirrorPath, dir], undefined, 300_000, scope), "clone");
  ok(await git(env, dir, ["config", "user.name", author.name], undefined, 120_000, scope), "config");
  ok(await git(env, dir, ["config", "user.email", author.email], undefined, 120_000, scope), "config");
  ok(await git(env, dir, ["remote", "add", "inbox", inboxPath(env)], undefined, 120_000, scope), "remote add");
  const remoteBranch = await git(env, dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], undefined, 120_000, scope);
  if (remoteBranch.exitCode === 0) {
    ok(await git(env, dir, ["checkout", "--quiet", "-b", branch, `origin/${branch}`], undefined, 120_000, scope), "checkout");
  } else {
    ok(await git(env, dir, ["checkout", "--quiet", "-b", branch], undefined, 120_000, scope), "checkout");
  }
  const head = ok(await git(env, dir, ["rev-parse", "HEAD"], undefined, 120_000, scope), "rev-parse").output.trim();
  return { scope, branch, head, resumed: remoteBranch.exitCode === 0, files: placeFiles(dir, files) };
}

export async function status(env: ExecEnv, scope: string) {
  const dir = worktreeDir(env, scope);
  const st = ok(await git(env, dir, ["status", "--short", "--branch"], undefined, 120_000, scope), "status");
  const log = await git(env, dir, ["log", "-5", "--oneline"], undefined, 120_000, scope);
  return { status: st.output.trim(), recent: log.exitCode === 0 ? log.output.trim() : "" };
}

export async function commit(env: ExecEnv, scope: string, message: string) {
  if (!message.trim() || message.length > 5000) throw new OpError("bad_request", "Commit message must be 1-5000 chars");
  const dir = worktreeDir(env, scope);
  ok(await git(env, dir, ["add", "-A"], undefined, 120_000, scope), "add");
  const staged = await git(env, dir, ["diff", "--cached", "--quiet"], undefined, 120_000, scope);
  if (staged.exitCode === 0) throw new OpError("conflict", "Nothing to commit");
  ok(await git(env, dir, ["commit", "--quiet", "-F", "-"], message, 120_000, scope), "commit");
  const head = ok(await git(env, dir, ["rev-parse", "--short", "HEAD"], undefined, 120_000, scope), "rev-parse").output.trim();
  return { head };
}

/** Pushes HEAD to this workstation's private inbox; swarmd's Git Relay takes it from there. */
export async function pushInbox(env: ExecEnv, scope: string, branch: string) {
  if (!BRANCH_PATTERN.test(branch)) throw new OpError("bad_request", "Invalid branch");
  const dir = worktreeDir(env, scope);
  const current = ok(await git(env, dir, ["rev-parse", "--abbrev-ref", "HEAD"], undefined, 120_000, scope), "rev-parse").output.trim();
  if (current !== branch) throw new OpError("conflict", `Worktree is on ${current}, expected ${branch}`);
  const inbox = inboxPath(env);
  if (!existsSync(join(inbox, "HEAD"))) {
    if (!existsSync(inbox)) throw new OpError("failed", "Push inbox is missing; rerun the workstation setup script");
    ok(await git(env, inbox, ["init", "--quiet", "--bare", "--shared=0640", "."]), "init inbox");
  }
  // --shared turns this on; the inbox is a private staging area and the Relay is the real gate.
  ok(await git(env, inbox, ["config", "receive.denyNonFastForwards", "false"]), "config inbox");
  ok(await git(env, dir, ["push", "--quiet", "--force", "inbox", `HEAD:refs/heads/${branch}`], undefined, 300_000, scope), "push to inbox");
  const head = ok(await git(env, dir, ["rev-parse", "HEAD"], undefined, 120_000, scope), "rev-parse").output.trim();
  return { branch, head, inbox };
}

/**
 * Fetches `branch` from the mirror (origin) and merges exactly `sha` (the reviewed commit); refuses if
 * the branch has moved since. On conflict, aborts and lists the files.
 */
export async function merge(env: ExecEnv, scope: string, branch: string, sha: string, message: string) {
  if (!BRANCH_PATTERN.test(branch)) throw new OpError("bad_request", "Invalid branch");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new OpError("bad_request", "Invalid commit");
  if (!message.trim() || message.length > 2000) throw new OpError("bad_request", "Merge message must be 1-2000 chars");
  const dir = worktreeDir(env, scope);
  const dirty = ok(await git(env, dir, ["status", "--porcelain", "--untracked-files=no"], undefined, 120_000, scope), "status").output.trim();
  if (dirty) throw new OpError("conflict", "Commit or discard your changes before merging");
  ok(await git(env, dir, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], undefined, 300_000, scope), "fetch");
  const tip = ok(await git(env, dir, ["rev-parse", `refs/remotes/origin/${branch}`], undefined, 30_000, scope), "rev-parse").output.trim();
  if (tip !== sha) throw new OpError("conflict", `${branch} moved since it was reviewed (now ${tip.slice(0, 10)}, reviewed ${sha.slice(0, 10)}); review it again`);
  const res = await git(env, dir, ["merge", "--no-ff", "--no-edit", "-m", message, sha], undefined, 300_000, scope);
  if (res.exitCode === 0) {
    const head = ok(await git(env, dir, ["rev-parse", "HEAD"], undefined, 30_000, scope), "rev-parse").output.trim();
    return { merged: true, head, conflicts: [] as string[] };
  }
  const conflicts = (await git(env, dir, ["diff", "--name-only", "--diff-filter=U"], undefined, 30_000, scope)).output.split("\n").filter(Boolean);
  await git(env, dir, ["merge", "--abort"], undefined, 30_000, scope);
  if (conflicts.length === 0) throw new OpError("failed", `merge failed: ${res.output.trim().slice(-500)}`);
  return { merged: false, head: null, conflicts };
}

/** Deletes a worktree with its own HOME and TMPDIR (after its pull request is merged or closed). Idempotent. */
export function remove(env: ExecEnv, scope: string) {
  if (!WORKTREE_SCOPE.test(scope)) throw new OpError("bad_request", "Not a worktree scope");
  const dir = resolveScope(env.root, scope);
  const existed = existsSync(dir);
  const s = space(env, scope);
  for (const d of [dir, s.home, s.tmp]) rmSync(d, { recursive: true, force: true });
  const repoDir = dirname(dir);
  if (existsSync(repoDir) && readdirSync(repoDir).length === 0) rmSync(repoDir, { recursive: true, force: true });
  return { removed: existed };
}

function worktreeDir(env: ExecEnv, scope: string): string {
  if (!WORKTREE_SCOPE.test(scope)) throw new OpError("bad_request", "Not a worktree scope");
  const dir = resolveScope(env.root, scope);
  if (!existsSync(join(dir, ".git"))) throw new OpError("not_found", `${scope} is not a git worktree`);
  return dir;
}

function checkMirror(env: ExecEnv, mirror: string): string {
  if (!mirror.endsWith(".git") || mirror.includes("..")) throw new OpError("bad_request", "Invalid mirror");
  let real: string;
  try {
    real = realpathSync(join(env.layout.mirrors, mirror));
  } catch {
    throw new OpError("not_found", `Mirror ${mirror} not found`);
  }
  const rel = relative(realpathSync(env.layout.mirrors), real);
  if (rel.startsWith("..") || rel.includes("/")) throw new OpError("out_of_scope", "Mirror outside the mirrors directory");
  return real;
}
