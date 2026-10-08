import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { SecretBox } from "./crypto/secret-box.ts";
import { PiRuntime } from "./agents/runtime/pi-runtime.ts";
import { createServices, type Logger } from "./app/services.ts";
import { buildApp } from "./app/build-app.ts";

const log: Logger = (level, msg, extra) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra })}\n`);
};

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);

  const secrets = await SecretBox.fromKeyFile(join(config.dataDir, "master.key"));
  const database = openDatabase(join(config.dataDir, "hive.db"));
  const runtime = await PiRuntime.create(config.dataDir);
  const services = createServices({ db: database.db, secrets, runtime, log, limits: { maxConcurrentRuns: config.maxConcurrentRuns } });
  await services.start();
  services.auth.pruneExpired();

  const app = await buildApp({ services, config, logger: false });
  await app.listen({ host: config.host, port: config.port });
  log("info", "hived listening", { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal });
    await services.manager.shutdown();
    await app.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log("error", "hived failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
