import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_LAYOUT } from "@agentswarm/ws-exec";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { SecretBox } from "./crypto/secret-box.ts";
import { createServices, type Logger } from "./app/services.ts";
import { buildApp } from "./http/app.ts";
import { SudoBackend } from "./workstations/backend.ts";
import { GitHubRest } from "./github/github-client.ts";
import { createGitRunner } from "./github/git.ts";
import { DiscordJsTransport } from "./discord/discord-js.ts";
import { buildLinearWebhook } from "./linear/linear-webhook.ts";

const log: Logger = (level, msg, extra) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra })}\n`);
};

async function main(): Promise<void> {
  if (process.getuid?.() === 0) throw new Error("swarmd must not run as root");
  process.umask(0o077);
  const config = loadConfig();
  const production = config.dataDir.startsWith(`${PRODUCTION_LAYOUT.volume}/`);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);

  const secrets = await SecretBox.fromKeyFile(join(config.dataDir, "master.key"));
  const database = openDatabase(join(config.dataDir, "agentswarm.db"));
  const services = createServices({
    db: database.db,
    secrets,
    backend: new SudoBackend(),
    githubClient: new GitHubRest(),
    git: createGitRunner({ askpassDir: config.dataDir, inboxGlob: `${PRODUCTION_LAYOUT.inbox}/*` }),
    layout: PRODUCTION_LAYOUT,
    maxConcurrentRuns: config.maxConcurrentRuns,
    heavySlots: config.heavySlots,
    screensDir: join(config.dataDir, "screens"),
    log,
    transport: new DiscordJsTransport(),
    linearPort: config.linearPort,
    dashboardUrl: config.dashboardUrl ?? `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`,
  });

  services.pool.resetLeases();
  const ws = await services.pool.sync();
  // Nothing an earlier swarmd started may keep running as a workstation user.
  await Promise.all(ws.map((w) => services.pool.reap(w.id).catch((e: Error) => log("warn", "reap failed", { ws: w.id, error: e.message }))));
  log("info", "workstations", { total: ws.length, unhealthy: ws.filter((w) => w.status === "unhealthy").map((w) => `${w.id}: ${w.lastError}`) });
  // The port deny list ws-exec reads must match the database (R5).
  services.machine.write();
  // Installed CLI versions and Codex sign-ins (R4); failures only show in the dashboard.
  void services.cli.refresh().catch(() => undefined);
  services.runs.recover();
  services.auth.pruneExpired();
  void services.github.verify().catch(() => undefined);

  // Linear's OAuth callback is registered at the local address: it stays the local one.
  const localUrl = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
  const app = await buildApp({
    services, webDist: config.webDist, dashboardUrl: localUrl,
    check: { dataDir: config.dataDir, volume: production ? PRODUCTION_LAYOUT.volume : null },
    // The Vite dev server proxies with its own Host header.
    allowedHosts: [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`, "localhost:5173", "127.0.0.1:5173", ...config.extraHosts],
  });
  await app.listen({ host: config.host, port: config.port });
  log("info", "swarmd listening", { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir });
  services.watcher.start();
  void services.discord.start();
  // Linear webhooks on their own loopback port (exposed alone through Tailscale Funnel).
  const webhook = buildLinearWebhook({ db: database.db, linear: services.linear, received: () => services.linearBridge.drain(), log: (msg, extra) => log("warn", msg, extra) });
  await webhook.listen({ host: "127.0.0.1", port: config.linearPort });
  services.linearBridge.start();
  log("info", "linear webhook listening", { url: `http://127.0.0.1:${config.linearPort}/linear/webhook` });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal });
    services.watcher.stop();
    services.linearBridge.stop();
    await webhook.close();
    await services.discord.stop();
    await services.runs.stopAll();
    await app.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: Error) => {
  log("error", "startup failed", { error: error.message });
  process.exit(1);
});
