import { join, resolve } from "node:path";

export interface HiveConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly webDistDir: string | null;
  readonly maxConcurrentRuns: number;
  readonly secureCookies: boolean;
  /** Host names accepted besides loopback, e.g. a Tailscale name when HIVE_HOST is not loopback. */
  readonly allowedHosts: readonly string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env: Record<string, string | undefined> = process.env): HiveConfig {
  const root = resolve(import.meta.dir, "../../..");
  const host = env.HIVE_HOST ?? "127.0.0.1";
  // Exposure beyond loopback (for example a Tailscale address) must be an explicit choice.
  if (!LOOPBACK.has(host) && env.HIVE_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`HIVE_HOST=${host} is not loopback; set HIVE_ALLOW_NON_LOOPBACK=1 to confirm`);
  }
  const port = Number(env.HIVE_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid HIVE_PORT: ${env.HIVE_PORT}`);
  const maxConcurrentRuns = Number(env.HIVE_MAX_CONCURRENT_RUNS ?? "3");
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error(`Invalid HIVE_MAX_CONCURRENT_RUNS: ${env.HIVE_MAX_CONCURRENT_RUNS}`);
  }
  return {
    host,
    port,
    dataDir: resolve(env.HIVE_DATA_DIR ?? join(root, ".hive-data")),
    webDistDir: env.HIVE_WEB_DIST === "" ? null : resolve(env.HIVE_WEB_DIST ?? join(root, "apps/web/dist")),
    maxConcurrentRuns,
    secureCookies: env.HIVE_SECURE_COOKIES === "1",
    allowedHosts: [
      ...(LOOPBACK.has(host) ? [] : [host.toLowerCase()]),
      ...(env.HIVE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    ],
  };
}
