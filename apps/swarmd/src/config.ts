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
  const host = env.SWARM_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && env.SWARM_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(`SWARM_HOST=${host} is not loopback; set SWARM_ALLOW_NON_LOOPBACK=1 to confirm`);
  }
  const port = Number(env.SWARM_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SWARM_PORT: ${env.SWARM_PORT}`);
  const maxConcurrentRuns = Number(env.SWARM_MAX_RUNS ?? "6");
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 16) throw new Error(`Invalid SWARM_MAX_RUNS: ${env.SWARM_MAX_RUNS}`);
  const repo = resolve(import.meta.dirname, "../../..");
  return {
    host,
    port,
    dataDir: resolve(env.SWARM_DATA_DIR ?? "/Volumes/SwarmWS/swarmd"),
    webDist: env.SWARM_WEB_DIST === "" ? null : resolve(env.SWARM_WEB_DIST ?? join(repo, "apps/web/dist")),
    maxConcurrentRuns,
  };
}
