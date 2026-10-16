import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SecretBox } from "../src/crypto/secret-box.ts";
import { hashPassword, verifyPassword } from "../src/crypto/tokens.ts";
import { scanAddedLines } from "../src/relay/secret-scan.ts";
import { clip } from "../src/events/event-bus.ts";
import { loadConfig } from "../src/config.ts";
import { systemPrompt } from "../src/agents/prompts.ts";

describe("units", () => {
  test("secret box round-trips and rejects tampering", async () => {
    const box = await SecretBox.fromRawKey(randomBytes(32));
    const sealed = await box.seal("hello");
    assert.equal(await box.open(sealed), "hello");
    const [v, iv, data] = sealed.split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0]! ^= 1;
    await assert.rejects(box.open(`${v}:${iv}:${flipped.toString("base64")}`));
  });

  test("scrypt passwords verify and reject", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.match(stored, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword("correct horse battery staple", stored), true);
    assert.equal(await verifyPassword("wrong", stored), false);
    assert.equal(await verifyPassword("x", "garbage"), false);
  });

  test("secret scan looks at added lines only", () => {
    const diff = ["+++ b/a.js", "+const k = 'AKIAABCDEFGHIJKLMNOP';", "-ghp_" + "a".repeat(36), "+token = 'github_pat_" + "b".repeat(50) + "'"].join("\n");
    assert.deepEqual(scanAddedLines(diff).sort(), ["AWS access key", "GitHub token"]);
  });

  test("event payloads keep the head and tail of long text", () => {
    const long = "a".repeat(10_000) + "b".repeat(10_000);
    const out = clip({ output: long }) as { output: string };
    assert.ok(out.output.length < long.length);
    assert.ok(out.output.startsWith("aaa") && out.output.endsWith("bbb"));
  });

  test("config refuses non-loopback hosts unless confirmed", () => {
    assert.throws(() => loadConfig({ HIVE_HOST: "0.0.0.0" }));
    assert.equal(loadConfig({ HIVE_HOST: "0.0.0.0", HIVE_ALLOW_NON_LOOPBACK: "1" }).host, "0.0.0.0");
    assert.throws(() => loadConfig({ HIVE_PORT: "99999" }));
  });

  test("the system prompt names the branch and forbids pushing the default branch", () => {
    const p = systemPrompt({ name: "Dev", role: "developer", instructions: "", repo: "o/r", defaultBranch: "main", branch: "hive/r/x" });
    assert.match(p, /hive\/r\/x/);
    assert.match(p, /never push main/);
  });
});

describe("local password reset", () => {
  test("replaces the hash and ends the user's sessions", async () => {
    const { openDatabase } = await import("../src/db/client.ts");
    const { AuthService } = await import("../src/auth/auth-service.ts");
    const db = openDatabase(":memory:");
    const auth = new AuthService(db.db);
    const admin = { username: "admin", password: "correct horse battery staple" };
    const { token } = await auth.setup(admin);
    await auth.resetPassword("admin", "a brand new long password");
    assert.equal(auth.resolve(token), null);
    await assert.rejects(auth.login(admin));
    assert.equal((await auth.login({ username: "admin", password: "a brand new long password" })).user.username, "admin");
    await assert.rejects(auth.resetPassword("nobody", "a brand new long password"), /No user/);
    db.close();
  });
});
