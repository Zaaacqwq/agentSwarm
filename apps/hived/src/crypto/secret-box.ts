import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

/** AES-256-GCM for secrets at rest (endpoint API keys). The key never enters the database. */
export class SecretBox {
  private constructor(private readonly key: CryptoKey) {}

  static async fromKeyFile(path: string): Promise<SecretBox> {
    return SecretBox.fromRawKey(loadOrCreateKey(path));
  }

  static async fromRawKey(raw: Uint8Array): Promise<SecretBox> {
    if (raw.byteLength !== KEY_BYTES) throw new Error("SecretBox key must be 32 bytes");
    const key = await crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
    return new SecretBox(key);
  }

  async seal(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = new TextEncoder().encode(plaintext);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, data));
    return `${VERSION}:${Buffer.from(iv).toString("base64")}:${Buffer.from(sealed).toString("base64")}`;
  }

  async open(ciphertext: string): Promise<string> {
    const [version, ivB64, dataB64] = ciphertext.split(":");
    if (version !== VERSION || !ivB64 || !dataB64) throw new Error("Unrecognized secret format");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(ivB64, "base64") },
      this.key,
      Buffer.from(dataB64, "base64"),
    );
    return new TextDecoder().decode(plain);
  }
}

function loadOrCreateKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`Master key ${path} must not be readable by group or others (mode ${mode.toString(8)})`);
    const raw = readFileSync(path);
    if (raw.byteLength !== KEY_BYTES) throw new Error(`Master key ${path} has unexpected length`);
    return new Uint8Array(raw);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return raw;
}
