import { describe, expect, test } from "bun:test";
import { AuthService, SESSION_TTL_MS } from "../src/auth/auth-service.ts";
import { RateLimiter } from "../src/auth/rate-limit.ts";
import { hashToken } from "../src/crypto/tokens.ts";
import { schema } from "../src/db/client.ts";
import { ADMIN, memoryDb } from "./helpers.ts";

describe("AuthService", () => {
  test("first setup creates admin and is then closed", async () => {
    const { db } = memoryDb();
    const auth = new AuthService(db);
    expect(auth.isSetupRequired()).toBe(true);
    const session = await auth.setupAdmin(ADMIN);
    expect(session.user.role).toBe("admin");
    expect(auth.isSetupRequired()).toBe(false);
    await expect(auth.setupAdmin({ username: "other", password: "another long password" })).rejects.toThrow("already");
  });

  test("stores only token hashes and resolves valid tokens", async () => {
    const { db } = memoryDb();
    const auth = new AuthService(db);
    const { token } = await auth.setupAdmin(ADMIN);
    const rows = db.select().from(schema.loginSessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(auth.resolve(token)?.username).toBe("admin");
    expect(auth.resolve("forged")).toBeNull();
    expect(auth.resolve(undefined)).toBeNull();
  });

  test("password is hashed, login checks it, and failures are audited", async () => {
    const { db } = memoryDb();
    const auth = new AuthService(db);
    await auth.setupAdmin(ADMIN);
    const user = db.select().from(schema.users).get()!;
    expect(user.passwordHash).not.toContain(ADMIN.password);
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    await expect(auth.login({ username: "admin", password: "wrong password!!" })).rejects.toThrow("Invalid");
    await expect(auth.login({ username: "nobody", password: "wrong password!!" })).rejects.toThrow("Invalid");
    const ok = await auth.login(ADMIN);
    expect(auth.resolve(ok.token)?.id).toBe(user.id);
    const actions = db.select().from(schema.auditLogs).all().map((a) => a.action);
    expect(actions).toEqual(["auth.setup", "auth.login_failed", "auth.login_failed", "auth.login"]);
    expect(JSON.stringify(db.select().from(schema.auditLogs).all())).not.toContain("wrong password");
  });

  test("expired sessions do not resolve and logout revokes", async () => {
    const { db } = memoryDb();
    const auth = new AuthService(db);
    const t0 = 1_000_000;
    const { token } = await auth.setupAdmin(ADMIN, t0);
    expect(auth.resolve(token, t0 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(auth.resolve(token, t0 + SESSION_TTL_MS + 1)).toBeNull();
    auth.pruneExpired(t0 + SESSION_TTL_MS + 1);
    expect(db.select().from(schema.loginSessions).all()).toHaveLength(0);

    const second = await auth.login(ADMIN);
    auth.logout(second.token);
    expect(auth.resolve(second.token)).toBeNull();
  });
});

describe("RateLimiter", () => {
  test("blocks after limit inside window and resets after", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit("ip", 0)).toBe(true);
    expect(rl.hit("ip", 10)).toBe(true);
    expect(rl.hit("ip", 20)).toBe(false);
    expect(rl.hit("other", 20)).toBe(true);
    expect(rl.hit("ip", 1000)).toBe(true);
  });
});
