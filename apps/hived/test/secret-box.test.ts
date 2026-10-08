import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox } from "../src/crypto/secret-box.ts";

describe("SecretBox", () => {
  test("round-trips and uses a fresh IV each time", async () => {
    const box = await SecretBox.fromRawKey(new Uint8Array(32).fill(7));
    const a = await box.seal("sk-or-secret");
    const b = await box.seal("sk-or-secret");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-or-secret");
    expect(await box.open(a)).toBe("sk-or-secret");
  });

  test("rejects tampered ciphertext and foreign keys", async () => {
    const box = await SecretBox.fromRawKey(new Uint8Array(32).fill(1));
    const other = await SecretBox.fromRawKey(new Uint8Array(32).fill(2));
    const sealed = await box.seal("value");
    await expect(other.open(sealed)).rejects.toThrow();
    await expect(box.open("v0:abc:def")).rejects.toThrow("Unrecognized");
  });

  test("creates a 0600 key file and refuses a loose one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-key-"));
    const path = join(dir, "sub", "master.key");
    const box = await SecretBox.fromKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = await SecretBox.fromKeyFile(path);
    expect(await again.open(await box.seal("x"))).toBe("x");
    chmodSync(path, 0o644);
    await expect(SecretBox.fromKeyFile(path)).rejects.toThrow("must not be readable");
  });
});
