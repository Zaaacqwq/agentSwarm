import { eq } from "drizzle-orm";
import type { GitHubStatus } from "@hive/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { audit } from "../audit.ts";
import { badRequest } from "../errors.ts";
import type { GitHubClient } from "./github-client.ts";

const ROW = "github";

/** Holds the one GitHub token Hive uses. Agents and workstations never see it. */
export class GitHubService {
  readonly client: GitHubClient;
  private readonly db: Db;
  private readonly secrets: SecretBox;

  constructor(db: Db, secrets: SecretBox, client: GitHubClient) {
    this.db = db;
    this.secrets = secrets;
    this.client = client;
  }

  async setToken(actor: string, token: string, now = Date.now()): Promise<GitHubStatus> {
    let info;
    try {
      info = await this.client.whoami(token);
    } catch (error) {
      throw badRequest(`GitHub rejected the token: ${(error as Error).message}`);
    }
    const values = { tokenSealed: await this.secrets.seal(token), login: info.login, expiresAt: info.expiresAt, checkedAt: now, error: null, updatedAt: now };
    this.db.insert(schema.githubCredentials).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.githubCredentials.id, set: values }).run();
    audit(this.db, actor, "github.token_set", info.login, { expiresAt: info.expiresAt }, now);
    return this.status();
  }

  status(): GitHubStatus {
    const row = this.db.select().from(schema.githubCredentials).where(eq(schema.githubCredentials.id, ROW)).get();
    return { configured: Boolean(row), login: row?.login ?? null, expiresAt: row?.expiresAt ?? null, checkedAt: row?.checkedAt ?? null, error: row?.error ?? null };
  }

  async token(): Promise<string> {
    const row = this.db.select().from(schema.githubCredentials).where(eq(schema.githubCredentials.id, ROW)).get();
    if (!row) throw badRequest("Add a GitHub token first");
    return this.secrets.open(row.tokenSealed);
  }

  /** Re-checks the stored token (startup and daily); failures show on the dashboard. */
  async verify(now = Date.now()): Promise<GitHubStatus> {
    const row = this.db.select().from(schema.githubCredentials).where(eq(schema.githubCredentials.id, ROW)).get();
    if (!row) return this.status();
    let error: string | null = null;
    let expiresAt = row.expiresAt;
    try {
      expiresAt = (await this.client.whoami(await this.secrets.open(row.tokenSealed))).expiresAt;
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    this.db.update(schema.githubCredentials).set({ checkedAt: now, error, expiresAt }).where(eq(schema.githubCredentials.id, ROW)).run();
    return this.status();
  }
}
