import { eq, gt, and, lt } from "drizzle-orm";
import type { Credentials, Me } from "@hive/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { hashPassword, hashToken, newId, newSessionToken, verifyPassword } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { conflict, unauthorized } from "../errors.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: Me;
}

export class AuthService {
  private readonly db: Db;
  /** Equalizes timing when the username does not exist. */
  private readonly dummy: Promise<string>;

  constructor(db: Db) {
    this.db = db;
    this.dummy = hashPassword("hive-timing-equalizer");
  }

  isSetupRequired(): boolean {
    return this.db.select({ id: schema.users.id }).from(schema.users).limit(1).all().length === 0;
  }

  /** Creates the first admin. Closed for good once any user exists. */
  async setup(input: Credentials, now = Date.now()): Promise<IssuedSession> {
    const passwordHash = await hashPassword(input.password);
    const user = this.db.transaction((tx) => {
      if (tx.select({ id: schema.users.id }).from(schema.users).limit(1).all().length > 0) throw conflict("Setup has already been completed");
      const row = { id: newId("usr"), username: input.username, passwordHash, role: "admin" as const, createdAt: now };
      tx.insert(schema.users).values(row).run();
      return row;
    });
    audit(this.db, user.id, "auth.setup", user.id, {}, now);
    return this.issue({ id: user.id, username: user.username, role: user.role }, now);
  }

  async login(input: Credentials, now = Date.now()): Promise<IssuedSession> {
    const row = this.db.select().from(schema.users).where(eq(schema.users.username, input.username)).get();
    const valid = await verifyPassword(input.password, row?.passwordHash ?? (await this.dummy));
    if (!row || !valid) {
      audit(this.db, "anonymous", "auth.login_failed", null, { username: input.username }, now);
      throw unauthorized("Invalid username or password");
    }
    audit(this.db, row.id, "auth.login", row.id, {}, now);
    return this.issue({ id: row.id, username: row.username, role: row.role }, now);
  }

  resolve(token: string | undefined, now = Date.now()): Me | null {
    if (!token) return null;
    const row = this.db
      .select({ user: schema.users })
      .from(schema.loginSessions)
      .innerJoin(schema.users, eq(schema.loginSessions.userId, schema.users.id))
      .where(and(eq(schema.loginSessions.tokenHash, hashToken(token)), gt(schema.loginSessions.expiresAt, now)))
      .get();
    return row ? { id: row.user.id, username: row.user.username, role: row.user.role } : null;
  }

  logout(token: string | undefined): void {
    if (token) this.db.delete(schema.loginSessions).where(eq(schema.loginSessions.tokenHash, hashToken(token))).run();
  }

  pruneExpired(now = Date.now()): void {
    this.db.delete(schema.loginSessions).where(lt(schema.loginSessions.expiresAt, now)).run();
  }

  private issue(user: Me, now: number): IssuedSession {
    const token = newSessionToken();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.insert(schema.loginSessions).values({ id: newId("ses"), userId: user.id, tokenHash: hashToken(token), createdAt: now, expiresAt }).run();
    return { token, expiresAt, user };
  }
}
