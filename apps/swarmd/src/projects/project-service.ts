import { chmodSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { CreateProject, ProjectView } from "@agentswarm/contracts";
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
}

export class ProjectService {
  private readonly deps: ProjectDeps;

  constructor(deps: ProjectDeps) {
    this.deps = deps;
  }

  list(): ProjectView[] {
    return this.deps.db.select().from(schema.projects).all().map(view);
  }

  get(id: string): ProjectRow {
    const row = this.deps.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) throw notFound("No such project");
    return row;
  }

  view(id: string): ProjectView {
    return view(this.get(id));
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
    const remoteUrl = this.deps.remoteUrl?.(info.fullName) ?? `https://github.com/${info.fullName}.git`;
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
    };
    db.insert(schema.projects).values(row).run();
    audit(db, actor, "project.create", row.id, { repo: row.githubRepo }, now);
    await this.ensureProtected(row.id).catch(() => undefined);
    return this.view(row.id);
  }

  /** Fetches GitHub into the mirror (heads only; Relay's refs/swarm-incoming/* stay). */
  async refresh(id: string, now = Date.now()): Promise<ProjectView> {
    const row = this.get(id);
    await gitOk(this.deps.git, ["fetch", "--quiet", "--prune", "origin"], { cwd: row.mirrorPath, token: await this.tokenFor(row), timeoutMs: 600_000 });
    shareReadOnly(row.mirrorPath);
    this.deps.db.update(schema.projects).set({ lastFetchedAt: now }).where(eq(schema.projects.id, id)).run();
    return this.view(id);
  }

  /** Turns on default-branch protection if it is off; records when it was last confirmed. */
  async ensureProtected(id: string, now = Date.now()): Promise<boolean> {
    const row = this.get(id);
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

function view(row: ProjectRow): ProjectView {
  return {
    id: row.id, slug: row.slug, name: row.name, githubRepo: row.githubRepo, defaultBranch: row.defaultBranch,
    protectedAt: row.protectedAt, lastFetchedAt: row.lastFetchedAt, createdAt: row.createdAt,
  };
}
