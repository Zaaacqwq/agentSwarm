import { and, eq, gt, lt } from "drizzle-orm";
import { newId, type Credentials } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { hashToken, newSessionToken } from "../crypto/tokens.ts";
import { writeAudit } from "../audit/audit.ts";
import { conflict, unauthorized } from "../http/errors.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_ORG_NAME = "Default";

export interface AuthUser {
  readonly id: string;
  readonly orgId: string;
  readonly username: string;
  readonly role: "admin" | "member";
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: AuthUser;
}

// A fixed hash so failed lookups take as long as a real verification.
const DUMMY_HASH = await Bun.password.hash("hive-timing-equalizer", { algorithm: "argon2id" });

export class AuthService {
  constructor(private readonly db: Db) {}

  isSetupRequired(): boolean {
    return this.db.select({ id: schema.users.id }).from(schema.users).limit(1).all().length === 0;
  }

  /** Creates the first admin and default org. Closed for good once any user exists. */
  async setupAdmin(input: Credentials, now = Date.now()): Promise<IssuedSession> {
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
    const user = this.db.transaction((tx) => {
      const exists = tx.select({ id: schema.users.id }).from(schema.users).limit(1).all();
      if (exists.length > 0) throw conflict("Setup has already been completed");
      const orgId = newId("org");
      const userId = newId("usr");
      tx.insert(schema.organizations).values({ id: orgId, name: DEFAULT_ORG_NAME, createdAt: now }).run();
      tx.insert(schema.users)
        .values({ id: userId, orgId, username: input.username, passwordHash, role: "admin", createdAt: now })
        .run();
      return { id: userId, orgId, username: input.username, role: "admin" as const };
    });
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "auth.setup" }, now);
    return this.issueSession(user, now);
  }

  async login(input: Credentials, now = Date.now()): Promise<IssuedSession> {
    const row = this.db.select().from(schema.users).where(eq(schema.users.username, input.username)).get();
    const valid = await Bun.password.verify(input.password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !valid) {
      writeAudit(this.db, { orgId: row?.orgId ?? null, actorKind: "system", actorId: null, action: "auth.login_failed", metadata: { username: input.username } }, now);
      throw unauthorized("Invalid username or password");
    }
    const user: AuthUser = { id: row.id, orgId: row.orgId, username: row.username, role: row.role };
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "auth.login" }, now);
    return this.issueSession(user, now);
  }

  resolve(token: string | undefined, now = Date.now()): AuthUser | null {
    if (!token) return null;
    const row = this.db
      .select({ user: schema.users })
      .from(schema.loginSessions)
      .innerJoin(schema.users, eq(schema.loginSessions.userId, schema.users.id))
      .where(and(eq(schema.loginSessions.tokenHash, hashToken(token)), gt(schema.loginSessions.expiresAt, now)))
      .get();
    if (!row) return null;
    return { id: row.user.id, orgId: row.user.orgId, username: row.user.username, role: row.user.role };
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.db.delete(schema.loginSessions).where(eq(schema.loginSessions.tokenHash, hashToken(token))).run();
  }

  pruneExpired(now = Date.now()): void {
    this.db.delete(schema.loginSessions).where(lt(schema.loginSessions.expiresAt, now)).run();
  }

  private issueSession(user: AuthUser, now: number): IssuedSession {
    const token = newSessionToken();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.insert(schema.loginSessions)
      .values({ id: newId("ses"), userId: user.id, tokenHash: hashToken(token), createdAt: now, expiresAt })
      .run();
    return { token, expiresAt, user };
  }
}
