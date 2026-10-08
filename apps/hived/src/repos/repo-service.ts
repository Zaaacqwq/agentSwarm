import { and, desc, eq, isNull } from "drizzle-orm";
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { newId, type CreateRepository, type Repository, type Worktree } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { gitOk, type GitRunner } from "./git-cli.ts";

type RepoRow = typeof schema.repositories.$inferSelect;
type WorktreeRow = typeof schema.worktrees.$inferSelect;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,59}$/;

/** Branch-safe slug for an agent name, e.g. "Ada Lovelace" -> "ada-lovelace". */
export function agentSlug(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || id.slice(-8).toLowerCase();
}

export interface RepoServiceDeps {
  readonly db: Db;
  readonly backend: WorkstationBackend;
  readonly git: GitRunner;
  readonly onWorktree: (worktree: Worktree) => void;
}

export class RepoService {
  constructor(private readonly deps: RepoServiceDeps) {}

  list(orgId: string): Repository[] {
    return this.deps.db.select().from(schema.repositories).where(eq(schema.repositories.orgId, orgId)).all().map(toRepo);
  }

  get(orgId: string, id: string): RepoRow {
    const row = this.deps.db.select().from(schema.repositories).where(and(eq(schema.repositories.id, id), eq(schema.repositories.orgId, orgId))).get();
    if (!row) throw notFound("Repository");
    return row;
  }

  byName(orgId: string, name: string): RepoRow | null {
    return this.deps.db.select().from(schema.repositories).where(and(eq(schema.repositories.orgId, orgId), eq(schema.repositories.name, name))).get() ?? null;
  }

  mirrorPath(repo: Pick<RepoRow, "mirrorName">): string {
    return join(this.deps.backend.layout.mirrors, repo.mirrorName);
  }

  /** Registers a repo and creates its bare mirror. remoteUrl defaults to GitHub (tests pass a local path). */
  async create(user: AuthUser, input: CreateRepository & { remoteUrl?: string }, now = Date.now()): Promise<Repository> {
    const [owner, name] = input.githubFullName.split("/") as [string, string];
    if (this.byName(user.orgId, name)) throw conflict(`A repository named ${name} is already registered`);
    const mirrorName = `${owner}__${name}.git`;
    const mirror = join(this.deps.backend.layout.mirrors, mirrorName);
    if (existsSync(mirror)) rmSync(mirror, { recursive: true, force: true });
    const remoteUrl = input.remoteUrl ?? `https://github.com/${input.githubFullName}.git`;
    try {
      await gitOk(this.deps.git, ["clone", "--quiet", "--mirror", remoteUrl, mirror], { timeoutMs: 600_000 });
    } catch (error) {
      throw badRequest(`Could not mirror ${input.githubFullName}: ${(error as Error).message}`);
    }
    // Workstation users clone from the mirror; core.sharedRepository keeps future objects world-readable.
    await gitOk(this.deps.git, ["config", "core.sharedRepository", "0644"], { cwd: mirror });
    openUp(mirror);
    const head = (await gitOk(this.deps.git, ["symbolic-ref", "--short", "HEAD"], { cwd: mirror })).trim();
    const row: RepoRow = {
      id: newId("repo"), orgId: user.orgId, name, githubFullName: input.githubFullName, remoteUrl,
      defaultBranch: input.defaultBranch ?? (head || "main"), mirrorName, createdAt: now,
    };
    this.deps.db.insert(schema.repositories).values(row).run();
    writeAudit(this.deps.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "repository.create", targetId: row.id, metadata: { repo: row.githubFullName } }, now);
    return toRepo(row);
  }

  async refresh(repo: RepoRow): Promise<void> {
    const mirror = this.mirrorPath(repo);
    await gitOk(this.deps.git, ["fetch", "--quiet", "--prune", repo.remoteUrl, "+refs/heads/*:refs/heads/*"], { cwd: mirror, timeoutMs: 600_000 });
  }

  remove(user: AuthUser, id: string, now = Date.now()): void {
    const repo = this.get(user.orgId, id);
    this.deps.db.delete(schema.repositories).where(eq(schema.repositories.id, id)).run();
    rmSync(this.mirrorPath(repo), { recursive: true, force: true });
    writeAudit(this.deps.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "repository.delete", targetId: id }, now);
  }

  // --- worktrees -----------------------------------------------------------

  activeWorktree(agentId: string): WorktreeRow | null {
    return this.deps.db.select().from(schema.worktrees)
      .where(and(eq(schema.worktrees.agentId, agentId), isNull(schema.worktrees.removedAt)))
      .orderBy(desc(schema.worktrees.lastUsedAt)).limit(1).get() ?? null;
  }

  worktree(id: string): WorktreeRow | null {
    return this.deps.db.select().from(schema.worktrees).where(eq(schema.worktrees.id, id)).get() ?? null;
  }

  worktreesFor(filter: { agentId?: string; workstationId?: string }): Worktree[] {
    const conds = [isNull(schema.worktrees.removedAt)];
    if (filter.agentId) conds.push(eq(schema.worktrees.agentId, filter.agentId));
    if (filter.workstationId) conds.push(eq(schema.worktrees.workstationId, filter.workstationId));
    return this.deps.db.select().from(schema.worktrees).where(and(...conds)).orderBy(desc(schema.worktrees.lastUsedAt)).all().map(toWorktree);
  }

  /** Opens (or resumes) the agent's worktree for repo/slug on its workstation and makes it active. */
  async checkout(input: { orgId: string; agent: { id: string; name: string }; workstation: { id: string; osUser: string }; repoName: string; slug: string }, now = Date.now()) {
    if (!SLUG.test(input.slug)) throw badRequest("slug must be lowercase letters, digits, . _ - (max 60)");
    const repo = this.byName(input.orgId, input.repoName);
    if (!repo) throw notFound(`Repository ${input.repoName}`);
    const who = agentSlug(input.agent.name, input.agent.id);
    const scope = `worktrees/${repo.name}/${who}-${input.slug}`;
    const branch = `hive/${who}/${input.slug}`;
    const existing = this.deps.db.select().from(schema.worktrees)
      .where(and(eq(schema.worktrees.workstationId, input.workstation.id), eq(schema.worktrees.scope, scope), isNull(schema.worktrees.removedAt))).get();
    if (existing) {
      if (existing.agentId !== input.agent.id) throw conflict("That worktree belongs to another agent");
      const row = this.deps.db.update(schema.worktrees).set({ lastUsedAt: now }).where(eq(schema.worktrees.id, existing.id)).returning().get()!;
      this.deps.onWorktree(toWorktree(row));
      return { worktree: toWorktree(row), resumed: true, created: false };
    }
    await this.refresh(repo);
    const cloned = await this.deps.backend.call<{ head: string; resumed: boolean }>(input.workstation.osUser, {
      op: "git.clone", scope, mirror: repo.mirrorName, branch, base: repo.defaultBranch,
    });
    const row = this.deps.db.insert(schema.worktrees).values({
      id: newId("wt"), workstationId: input.workstation.id, repositoryId: repo.id, agentId: input.agent.id, scope, branch, createdAt: now, lastUsedAt: now,
    }).returning().get();
    this.deps.onWorktree(toWorktree(row));
    return { worktree: toWorktree(row), resumed: cloned.resumed, created: true };
  }

  touch(worktreeId: string, now = Date.now()): void {
    this.deps.db.update(schema.worktrees).set({ lastUsedAt: now }).where(eq(schema.worktrees.id, worktreeId)).run();
  }

  async removeWorktree(worktreeId: string, osUser: string, now = Date.now()): Promise<void> {
    const wt = this.worktree(worktreeId);
    if (!wt || wt.removedAt) throw notFound("Worktree");
    await this.deps.backend.call(osUser, { op: "git.remove", scope: wt.scope });
    this.deps.db.update(schema.worktrees).set({ removedAt: now }).where(eq(schema.worktrees.id, worktreeId)).run();
  }
}

/** Mirrors are read by workstation users (others), so make them world-readable. */
function openUp(path: string): void {
  const st = statSync(path);
  chmodSync(path, st.isDirectory() ? 0o755 : 0o644);
  if (!st.isDirectory()) return;
  for (const name of readdirSync(path)) openUp(join(path, name));
}

function toRepo(row: RepoRow): Repository {
  return { id: row.id, name: row.name, githubFullName: row.githubFullName, defaultBranch: row.defaultBranch, createdAt: row.createdAt };
}

export function toWorktree(row: WorktreeRow): Worktree {
  return { id: row.id, workstationId: row.workstationId, repositoryId: row.repositoryId, agentId: row.agentId, scope: row.scope, branch: row.branch, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}
