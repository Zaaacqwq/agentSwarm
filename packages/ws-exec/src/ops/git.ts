import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";

/** swarm/<project>/<part>[/<sub-part>...]: one segment per level of the agent tree (R2). */
export const BRANCH_PATTERN = /^swarm\/[a-z0-9][a-z0-9-]{0,39}(\/[a-z0-9][a-z0-9-]{0,59}){1,4}$/;
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const WORKTREE_SCOPE = /^worktrees\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const AUTHOR = { name: "agentSwarm Agent", email: "agent@agentswarm.local" };

async function git(env: ExecEnv, cwd: string, args: string[], stdin?: string, timeoutMs = 120_000, scope?: string) {
  return runProcess(env, sandboxed(env, ["/usr/bin/git", ...args], scope), { cwd, timeoutMs, ...(stdin !== undefined ? { stdin } : {}) });
}

function ok<T extends { exitCode: number | null; output: string }>(res: T, what: string): T {
  if (res.exitCode !== 0) throw new OpError("failed", `${what} failed: ${res.output.trim().slice(-800)}`);
  return res;
}

function inboxPath(env: ExecEnv): string {
  return `${env.layout.inbox}/${env.user}.git`;
}

export async function clone(env: ExecEnv, scope: string, mirror: string, branch: string, base: string, author = AUTHOR) {
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
      return { scope, branch, head, resumed: true };
    }
    throw new OpError("conflict", `Worktree ${scope} already exists on another branch`);
  }

  ok(await git(env, parent, ["clone", "--quiet", "--no-hardlinks", "--branch", base, mirrorPath, dir], undefined, 300_000, scope), "clone");
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
  return { scope, branch, head, resumed: remoteBranch.exitCode === 0 };
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

export function remove(env: ExecEnv, scope: string) {
  const dir = worktreeDir(env, scope);
  rmSync(dir, { recursive: true, force: true });
  const repoDir = dirname(dir);
  if (readdirSync(repoDir).length === 0) rmSync(repoDir, { recursive: true, force: true });
  return { removed: scope };
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
