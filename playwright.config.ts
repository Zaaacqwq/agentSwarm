import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4399", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: "npm run build:web && node apps/swarmd/test/e2e-server.ts",
    url: "http://127.0.0.1:4399/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
