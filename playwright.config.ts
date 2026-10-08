import { defineConfig, devices } from "@playwright/test";

const HIVED_PORT = 4396;
const MODEL_PORT = 4391;
const BUN = process.env.BUN_BIN ?? "bun";

export default defineConfig({
  testDir: "e2e",
  outputDir: ".tmp/e2e-results",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${HIVED_PORT}`, channel: "chrome", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    { command: `${BUN} apps/hived/test/fake-model-server.ts ${MODEL_PORT}`, port: MODEL_PORT, reuseExistingServer: false },
    {
      command: `rm -rf .tmp/e2e-data && HIVE_DATA_DIR=.tmp/e2e-data HIVE_PORT=${HIVED_PORT} ${BUN} apps/hived/src/main.ts`,
      url: `http://127.0.0.1:${HIVED_PORT}/api/auth/session`,
      reuseExistingServer: false,
    },
  ],
});
