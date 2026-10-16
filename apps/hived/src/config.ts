import { join, resolve } from "node:path";

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  /** Built web UI to serve, or null in development (Vite serves it). */
  readonly webDist: string | null;
  readonly maxConcurrentRuns: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HIVE_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && env.HIVE_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`HIVE_HOST=${host} is not loopback; set HIVE_ALLOW_NON_LOOPBACK=1 to confirm`);
  }
  const port = Number(env.HIVE_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid HIVE_PORT: ${env.HIVE_PORT}`);
  const maxConcurrentRuns = Number(env.HIVE_MAX_RUNS ?? "6");
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 16) throw new Error(`Invalid HIVE_MAX_RUNS: ${env.HIVE_MAX_RUNS}`);
  const repo = resolve(import.meta.dirname, "../../..");
  return {
    host,
    port,
    dataDir: resolve(env.HIVE_DATA_DIR ?? "/Volumes/HiveWS/hived"),
    webDist: env.HIVE_WEB_DIST === "" ? null : resolve(env.HIVE_WEB_DIST ?? join(repo, "apps/web/dist")),
    maxConcurrentRuns,
  };
}
