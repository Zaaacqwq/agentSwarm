import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { CreateProject, ProjectView, PutProjectFile, SetProjectProfile } from "@agentswarm/contracts";
import type { SecretBox } from "../crypto/secret-box.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { gitOk, type GitRunner } from "../github/git.ts";
import type { GitHubService } from "../github/github-service.ts";

export type ProjectRow = typeof schema.projects.$inferSelect;

export interface ProjectDeps {
  readonly db: Db;
  readonly github: GitHubService;
  readonly git: GitRunner;
  /** Where bare mirrors live (workstations read them). */
  readonly mirrorsDir: string;
  /** Tests point this at a local bare repository; production uses GitHub over HTTPS. */
  readonly remoteUrl?: (fullName: string) => string;
  /** Seals the projects' local files (R5). */
  readonly secrets: SecretBox;
}

const SEGMENT = /^[A-Za-z0-9._@+ -]{1,100}$/;

/**
 * A project file path: relative, segments of safe characters, no "." / ".." / empty segments, and no
 * ".git" segment in any case (APFS is case-insensitive). The same rule as ws-exec's projectFilePath.
 */
/** Prefixes of tickets that have no project of their own yet (R7). */
export const RESERVED_PREFIXES = new Set(["SBX", "IDEA"]);

/** A project's ticket prefix: the one set, else its name's first letters (Fridgy → FRI). */
export function ticketPrefixOf(row: { ticketPrefix: string | null; name: string }): string {
  if (row.ticketPrefix) return row.ticketPrefix;
  const letters = row.name.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "");
  const prefix = (letters || "P").slice(0, 3);
  return RESERVED_PREFIXES.has(prefix) ? `${prefix}P` : prefix;
}

export function projectFilePath(path: string): string | null {
  if (path.length < 1 || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.some((p) => !SEGMENT.test(p) || p === "." || p === ".." || p.toLowerCase() === ".git" || p.trim() !== p)) return null;
  return parts.join("/");
}

/** Local files written into every worktree: a project may need a few, never many or large ones. */
export const PROJECT_FILE_LIMITS = { count: 20, bytes: 256 * 1024, total: 1024 * 1024 } as const;

export class ProjectService {
  private readonly deps: ProjectDeps;

  constructor(deps: ProjectDeps) {
    this.deps = deps;
  }

  /** Projects in use: archived local projects (R10) are left out. */
  list(): ProjectView[] {
    return this.deps.db.select().from(schema.projects).where(isNull(schema.projects.archivedAt)).all().map((r) => this.toView(r));
  }

  /**
   * R10: a local project you dropped, or a quick test cleaned up after a week: its repository is removed; the
   * project row stays (archived) so its tickets and missions keep their history.
   */
  archiveLocal(actor: string, id: string, now = Date.now()): void {
    const row = this.get(id);
    if (row.kind !== "local") throw badRequest("Only a local project is archived");
    if (row.archivedAt) return;
    rmSync(row.mirrorPath, { recursive: true, force: true });
    this.deps.db.update(schema.projects).set({ archivedAt: now }).where(eq(schema.projects.id, id)).run();
    audit(this.deps.db, actor, "project.archive", id, { name: row.name }, now);
  }

  get(id: string): ProjectRow {
    const row = this.deps.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) throw notFound("No such project");
    return row;
  }

  view(id: string): ProjectView {
    return this.toView(this.get(id));
  }



  /**
   * A project that lives only on this Mac (R5): a sandbox experiment or an idea. Its mirror starts with
   * one commit; agents work on it as on any project, but the Relay never pushes it anywhere.
   */
  async createLocal(actor: string, name: string, now = Date.now()): Promise<ProjectView> {
    const { db, git } = this.deps;
    const slug = this.uniqueSlug(`local-${name}`);
    const mirrorPath = join(this.deps.mirrorsDir, `${slug}.git`);
    const work = mkdtempSync(join(tmpdir(), "agentswarm-local-"));
    try {
      writeFileSync(join(work, "README.md"), `# ${name}\n\nA local agentSwarm project (sandbox or idea). It lives only on this Mac.\n`);
      const g = (args: string[], cwd = work) => gitOk(git, ["-c", "user.name=agentSwarm", "-c", "user.email=agentswarm@localhost", ...args], { cwd });
      await g(["init", "--quiet", "-b", "main"]);
      await g(["add", "-A"]);
      await g(["commit", "--quiet", "-m", "Start"]);
      await gitOk(git, ["clone", "--quiet", "--bare", "--config", "core.sharedRepository=0644", work, mirrorPath], { cwd: this.deps.mirrorsDir });
      await gitOk(git, ["remote", "remove", "origin"], { cwd: mirrorPath });
      shareReadOnly(mirrorPath);
    } catch (error) {
      rmSync(mirrorPath, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    const row: ProjectRow = {
      id: newId("prj"), slug, name, githubRepo: `local/${slug}`, remoteUrl: "", defaultBranch: "main", mirrorPath,
      protectedAt: null, lastFetchedAt: now, createdAt: now, kind: "local", profile: null, ticketPrefix: null, archivedAt: null,
    };
    db.insert(schema.projects).values(row).run();
    audit(db, actor, "project.create_local", row.id, { name }, now);
    return this.view(row.id);
  }

  /**
   * The project's ticket prefix, fixed the first time it is needed: derived from its name, with a number added when
   * another project already uses it (Fridgy FRI, Friends FRI2), so every project numbers its own tickets.
   */
  ensurePrefix(id: string): string {
    const row = this.get(id);
    if (row.ticketPrefix) return row.ticketPrefix;
    // First come, first served: only prefixes other projects have fixed already are taken.
    // So are prefixes other projects' tickets still carry (a project that changed its prefix keeps its old tickets).
    const inUse = this.deps.db.selectDistinct({ prefix: schema.tickets.prefix, projectId: schema.tickets.projectId }).from(schema.tickets).all()
      .filter((t) => t.projectId !== id).map((t) => t.prefix);
    const taken = new Set([...RESERVED_PREFIXES, ...inUse, ...this.deps.db.select().from(schema.projects).all().filter((p) => p.id !== id && p.ticketPrefix).map((p) => p.ticketPrefix!)]);
    const base = ticketPrefixOf(row).slice(0, 5);
    let prefix = ticketPrefixOf(row);
    for (let n = 2; taken.has(prefix); n++) prefix = `${base}${n}`;
    this.deps.db.update(schema.projects).set({ ticketPrefix: prefix }).where(eq(schema.projects.id, id)).run();
    return prefix;
  }

  setProfile(actor: string, id: string, input: SetProjectProfile, now = Date.now()): ProjectView {
    this.get(id);
    if (input.ticketPrefix) {
      const taken = this.list().find((p) => p.id !== id && p.ticketPrefix === input.ticketPrefix);
      const onTickets = this.deps.db.select({ projectId: schema.tickets.projectId }).from(schema.tickets).where(eq(schema.tickets.prefix, input.ticketPrefix)).all().some((t) => t.projectId !== id);
      if (taken || onTickets || RESERVED_PREFIXES.has(input.ticketPrefix)) throw conflict(`The ticket prefix ${input.ticketPrefix} is already used${taken ? ` by ${taken.name}` : ""}`);
    }
    this.deps.db.update(schema.projects).set({
      profile: input.profile,
      ...(input.ticketPrefix !== undefined ? { ticketPrefix: input.ticketPrefix } : {}),
    }).where(eq(schema.projects.id, id)).run();
    audit(this.deps.db, actor, "project.profile", id, { ticketPrefix: input.ticketPrefix ?? null }, now);
    return this.view(id);
  }

  async putFile(actor: string, id: string, input: PutProjectFile, now = Date.now()): Promise<ProjectView> {
    this.get(id);
    const path = projectFilePath(input.path);
    if (!path) throw badRequest("Invalid path: use a relative path without ., .. or .git parts");
    input = { ...input, path };
    const existing = this.fileRows(id);
    if (!existing.some((f) => f.path === input.path) && existing.length >= PROJECT_FILE_LIMITS.count) throw badRequest(`At most ${PROJECT_FILE_LIMITS.count} files per project`);
    if (Buffer.byteLength(input.content) > PROJECT_FILE_LIMITS.bytes) throw badRequest("The file is too large (256 KB at most)");
    // Every clone carries all of them to the workstation (ws-exec takes at most 4 MB per request).
    const others = (await this.files(id)).filter((f) => f.path !== path).reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);
    if (others + Buffer.byteLength(input.content) > PROJECT_FILE_LIMITS.total) throw badRequest("A project's local files may add up to 1 MB at most");
    const values = { contentSealed: await this.deps.secrets.seal(input.content), updatedAt: now };
    this.deps.db.insert(schema.projectFiles).values({ projectId: id, path: input.path, ...values })
      .onConflictDoUpdate({ target: [schema.projectFiles.projectId, schema.projectFiles.path], set: values }).run();
    audit(this.deps.db, actor, "project.file_put", id, { path: input.path }, now);
    return this.view(id);
  }

  deleteFile(actor: string, id: string, path: string, now = Date.now()): ProjectView {
    this.get(id);
    if (!projectFilePath(path)) throw badRequest("Invalid path");
    this.deps.db.delete(schema.projectFiles).where(and(eq(schema.projectFiles.projectId, id), eq(schema.projectFiles.path, path))).run();
    audit(this.deps.db, actor, "project.file_delete", id, { path }, now);
    return this.view(id);
  }

  /** The files' contents, opened only to write them into a worktree. */
  async files(id: string): Promise<{ path: string; content: string }[]> {
    return Promise.all(this.fileRows(id).map(async (f) => ({ path: f.path, content: await this.deps.secrets.open(f.contentSealed) })));
  }

  /** A file from a branch of the mirror (local projects' documents have no GitHub page). */
  async blob(id: string, ref: string, path: string): Promise<string> {
    const row = this.get(id);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw badRequest("Invalid ref");
    if (!/^[A-Za-z0-9._@+ /-]{1,300}$/.test(path) || path.split("/").includes("..")) throw badRequest("Invalid path");
    const res = await this.deps.git(["show", `refs/heads/${ref}:${path}`], { cwd: row.mirrorPath });
    if (res.code !== 0) throw notFound(`No ${path} on ${ref}`);
    return res.out.slice(0, 1024 * 1024);
  }

  /** Paths a push must never contain (the local files are secrets, or at least not the repository's). */
  protectedPaths(id: string): string[] {
    return this.fileRows(id).map((f) => f.path);
  }

  private fileRows(id: string) {
    return this.deps.db.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, id)).all();
  }

  private toView(row: ProjectRow): ProjectView {
    return {
      id: row.id, slug: row.slug, name: row.name, githubRepo: row.githubRepo, defaultBranch: row.defaultBranch,
      protectedAt: row.protectedAt, lastFetchedAt: row.lastFetchedAt, createdAt: row.createdAt,
      kind: row.kind, profile: row.profile ?? {}, ticketPrefix: ticketPrefixOf(row),
      files: this.fileRows(row.id).map((f) => ({ path: f.path, updatedAt: f.updatedAt })),
    };
  }

  /** Registers a GitHub repository: checks access, mirrors it, and protects its default branch. */
  async create(actor: string, input: CreateProject, now = Date.now()): Promise<ProjectView> {
    const { db, github, git } = this.deps;
    if (db.select().from(schema.projects).where(eq(schema.projects.githubRepo, input.githubRepo)).get()) throw conflict("That repository is already a project");
    const token = await github.token();
    const info = await github.client.repo(token, input.githubRepo).catch((e: Error) => {
      throw badRequest(`Cannot read ${input.githubRepo} with agentSwarm's token: ${e.message}`);
    });
    const slug = this.uniqueSlug(info.fullName.split("/")[1] ?? "project");
    const mirrorPath = join(this.deps.mirrorsDir, `${slug}.git`);
    const remoteUrl = this.remoteUrlFor(info.fullName);
    if (existsSync(mirrorPath)) rmSync(mirrorPath, { recursive: true, force: true });
    try {
      await gitOk(git, ["clone", "--quiet", "--bare", "--config", "core.sharedRepository=0644", remoteUrl, mirrorPath], { token, timeoutMs: 600_000 });
      await gitOk(git, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], { cwd: mirrorPath });
      shareReadOnly(mirrorPath);
    } catch (error) {
      rmSync(mirrorPath, { recursive: true, force: true });
      throw badRequest(`Could not mirror ${info.fullName}: ${(error as Error).message}`);
    }
    const row: ProjectRow = {
      id: newId("prj"), slug, name: input.name ?? info.fullName.split("/")[1] ?? slug, githubRepo: info.fullName, remoteUrl,
      defaultBranch: info.defaultBranch, mirrorPath, protectedAt: null, lastFetchedAt: now, createdAt: now,
      kind: "github", profile: null, ticketPrefix: null, archivedAt: null,
    };
    db.insert(schema.projects).values(row).run();
    audit(db, actor, "project.create", row.id, { repo: row.githubRepo }, now);
    await this.ensureProtected(row.id).catch(() => undefined);
    return this.view(row.id);
  }

  /** Fetches GitHub into the mirror (heads only; Relay's refs/swarm-incoming/* stay). */
  async refresh(id: string, now = Date.now()): Promise<ProjectView> {
    const row = this.get(id);
    if (row.kind === "local") return this.view(id);
    await gitOk(this.deps.git, ["fetch", "--quiet", "--prune", "origin"], { cwd: row.mirrorPath, token: await this.tokenFor(row), timeoutMs: 600_000 });
    shareReadOnly(row.mirrorPath);
    this.deps.db.update(schema.projects).set({ lastFetchedAt: now }).where(eq(schema.projects.id, id)).run();
    return this.view(id);
  }

  /** Turns on default-branch protection if it is off; records when it was last confirmed. */
  async ensureProtected(id: string, now = Date.now()): Promise<boolean> {
    const row = this.get(id);
    if (row.kind === "local") return false;
    const token = await this.deps.github.token();
    const client = this.deps.github.client;
    let ok = await client.isProtected(token, row.githubRepo, row.defaultBranch);
    if (!ok) {
      await client.protect(token, row.githubRepo, row.defaultBranch);
      ok = await client.isProtected(token, row.githubRepo, row.defaultBranch);
    }
    this.deps.db.update(schema.projects).set({ protectedAt: ok ? now : null }).where(eq(schema.projects.id, id)).run();
    if (ok) audit(this.deps.db, "system", "project.protected", id, { branch: row.defaultBranch }, now);
    return ok;
  }

  /** Where a GitHub repository is pushed to and cloned from. */
  remoteUrlFor(fullName: string): string {
    return this.deps.remoteUrl?.(fullName) ?? `https://github.com/${fullName}.git`;
  }

  /** Local test remotes need no token. */
  async tokenFor(row: ProjectRow): Promise<string | undefined> {
    return row.remoteUrl.startsWith("https://") ? this.deps.github.token() : undefined;
  }

  private uniqueSlug(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project";
    let slug = base;
    for (let n = 2; this.deps.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, slug)).get(); n++) slug = `${base}-${n}`;
    return slug;
  }
}

/** Workstations read mirrors; swarmd runs with umask 077, so open up what git wrote. */
export function shareReadOnly(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if ((st.mode & 0o755) !== 0o755) chmodSync(dir, (st.mode & 0o777) | 0o755);
    for (const name of readdirSync(dir)) shareReadOnly(join(dir, name));
  } else if ((st.mode & 0o444) !== 0o444) {
    chmodSync(dir, (st.mode & 0o777) | 0o444);
  }
}


