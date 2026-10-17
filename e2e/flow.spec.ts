import { expect, test } from "@playwright/test";

const SHOTS = "test-results/screens";

test("set up agentSwarm, add a project and an agent, and watch a run fix a bug", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "agentSwarm" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("API key").fill("sk-or-e2e-key-value");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(page.getByText("key stored")).toBeVisible();
  await page.getByLabel("Fine-grained token").fill("github_pat_e2e_token_value_123456");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByText("tester")).toBeVisible();

  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByLabel("GitHub repository").fill("tester/demo");
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByText("main protected")).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Name").fill("Dev");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "Dev" })).toBeVisible();

  await page.getByLabel("Title").fill("Fix square");
  await page.getByLabel("Brief").fill("square(3) must be 9; fix it and run the tests.");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Fix square" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Report" }).getByText("square now multiplies; the test passes.")).toBeVisible();
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByText("✓ ws_bash", { exact: false })).toBeVisible();
  await expect(timeline.getByText("pushed", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Sub-agents reported").first()).toBeVisible();
  await expect(page.getByText(/^Pull request: https:\/\/github\.com\/tester\/demo\/pull\/1$/)).toBeVisible();
  const tree = page.getByRole("region", { name: "Agent tree" });
  await expect(tree.getByRole("link", { name: "Helper", exact: true })).toBeVisible();
  await expect(tree.getByText("approved", { exact: true })).toBeVisible();
  await expect(tree.getByText("merged", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/run-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/run-375.png`, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await tree.getByRole("link", { name: "Helper", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Helper" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Report" }).getByText("Fixed square.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/child-1440.png`, fullPage: true });
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByText("pushed", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Workstations" }).click();
  await expect(page.getByRole("heading", { name: "ws-1" })).toBeVisible();
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("System checks")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/overview-1440.png`, fullPage: true });
});
