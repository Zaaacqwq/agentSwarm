import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { webcrypto } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

/** AES-256-GCM for secrets at rest (API keys, the GitHub token). The key never enters the database. */
export class SecretBox {
  private readonly key: webcrypto.CryptoKey;

  private constructor(key: webcrypto.CryptoKey) {
    this.key = key;
  }

  static async fromKeyFile(path: string): Promise<SecretBox> {
    return SecretBox.fromRawKey(loadOrCreateKey(path));
  }

  static async fromRawKey(raw: Uint8Array): Promise<SecretBox> {
    if (raw.byteLength !== KEY_BYTES) throw new Error("SecretBox key must be 32 bytes");
    return new SecretBox(await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  async seal(plaintext: string): Promise<string> {
    const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, new TextEncoder().encode(plaintext)));
    return `${VERSION}:${Buffer.from(iv).toString("base64")}:${Buffer.from(sealed).toString("base64")}`;
  }

  async open(ciphertext: string): Promise<string> {
    const [version, iv, data] = ciphertext.split(":");
    if (version !== VERSION || !iv || !data) throw new Error("Unrecognized secret format");
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64") }, this.key, Buffer.from(data, "base64"));
    return new TextDecoder().decode(plain);
  }
}

function loadOrCreateKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`Master key ${path} must not be readable by group or others (mode ${mode.toString(8)})`);
    const raw = readFileSync(path);
    if (raw.byteLength !== KEY_BYTES) throw new Error(`Master key ${path} has an unexpected length`);
    return new Uint8Array(raw);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const raw = webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
  writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return raw;
}
