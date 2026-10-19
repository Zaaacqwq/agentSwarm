import { join, resolve } from "node:path";

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  /** Built web UI to serve, or null in development (Vite serves it). */
  readonly webDist: string | null;
  readonly maxConcurrentRuns: number;
  /** R6: runs with a simulator or browser at once (SWARM_HEAVY_SLOTS, default 2 for 16 GB). */
  readonly heavySlots: number;
  /** Linear webhooks (R5): their own loopback port, the only one Tailscale Funnel exposes. */
  readonly linearPort: number;
  /** Where people open the dashboard, for links in Linear and Discord (e.g. through Tailscale serve). */
  readonly dashboardUrl: string | null;
  /** More Host names the dashboard answers to (e.g. mac-mini.tailnet.ts.net:8444). */
  readonly extraHosts: readonly string[];
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
  const heavySlots = Number(env.SWARM_HEAVY_SLOTS ?? "2");
  if (!Number.isInteger(heavySlots) || heavySlots < 1 || heavySlots > 8) throw new Error(`Invalid SWARM_HEAVY_SLOTS: ${env.SWARM_HEAVY_SLOTS}`);
  const linearPort = Number(env.SWARM_LINEAR_PORT ?? "4319");
  if (!Number.isInteger(linearPort) || linearPort < 1 || linearPort > 65535 || linearPort === port) throw new Error(`Invalid SWARM_LINEAR_PORT: ${env.SWARM_LINEAR_PORT}`);
  const repo = resolve(import.meta.dirname, "../../..");
  return {
    host,
    port,
    dataDir: resolve(env.SWARM_DATA_DIR ?? "/Volumes/SwarmWS/swarmd"),
    webDist: env.SWARM_WEB_DIST === "" ? null : resolve(env.SWARM_WEB_DIST ?? join(repo, "apps/web/dist")),
    maxConcurrentRuns,
    heavySlots,
    linearPort,
    dashboardUrl: env.SWARM_DASHBOARD_URL ? new URL(env.SWARM_DASHBOARD_URL).origin : null,
    extraHosts: (env.SWARM_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}
