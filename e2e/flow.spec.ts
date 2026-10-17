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

test("start a mission on the dashboard, answer the lead, approve its plan, and get a pull request", async ({ page }) => {
  await page.goto("/missions");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Missions" })).toBeVisible();
  await expect(page.getByText("No missions yet")).toBeVisible();
  await page.getByRole("button", { name: "New mission" }).click();
  await page.getByLabel("Your idea").fill("Add a cube function next to square");
  await page.getByLabel("Fast track").check();
  await page.screenshot({ path: `${SHOTS}/mission-new-1440.png`, fullPage: true });
  await page.getByRole("button", { name: "Start the mission" }).click();

  await expect(page.getByRole("heading", { name: "Add a cube function next to square" })).toBeVisible();
  const chat = page.getByRole("region", { name: "Conversation" });
  await expect(chat.getByText("Should cube(2) return 8, and does it go in math.js?")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Needs you · Intake")).toBeVisible();
  await page.getByLabel("Your answer").fill("Yes, 8, and a new file is fine.");
  await page.getByRole("button", { name: "Answer" }).click();

  const gate = page.getByRole("region", { name: "The plan is waiting for your approval" });
  await expect(gate).toBeVisible({ timeout: 20_000 });
  await expect(gate.getByText("One package: cube(x) in math.js")).toBeVisible();
  await expect(page.getByRole("link", { name: "plan.md ↗" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mission-gate-1440.png`, fullPage: true });
  await gate.getByRole("button", { name: "Approve the plan" }).click();

  const merge = page.getByRole("region", { name: "The pull request is ready" });
  await expect(merge).toBeVisible({ timeout: 30_000 });
  await expect(merge.getByRole("link", { name: "Open the pull request ↗" })).toHaveAttribute("href", "https://github.com/tester/demo/pull/2");
  await expect(page.getByRole("link", { name: "acceptance.md ↗" })).toBeVisible();
  const tree = page.getByRole("region", { name: "Agent tree" });
  await expect(tree.getByRole("link", { name: "Builder", exact: true })).toBeVisible();
  await expect(tree.getByText("merged", { exact: true })).toBeVisible();
  await expect(chat.getByText("Yes, 8, and a new file is fine.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mission-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/mission-375.png`, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Missions" }).click();
  await expect(page.getByText("Needs you · Waiting for you to merge")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/missions-1440.png`, fullPage: true });
});

test("connect Claude Code and Codex, then watch a Claude Code sub-agent do the work", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  const cli = page.getByRole("region", { name: "CLI workers" });
  await expect(cli).toBeVisible();
  await expect(cli.getByText("version 2.1.302", { exact: false })).toBeVisible();
  await cli.getByLabel("Long-lived token").fill("sk-ant-oat01-e2e-token-value-0123456789");
  await cli.getByRole("button", { name: "Save Claude token" }).click();
  await expect(cli.getByRole("button", { name: "Replace Claude token" })).toBeVisible();
  await cli.getByRole("button", { name: "Sign in" }).first().click();
  await expect(cli.getByLabel("One-time code")).toHaveText("FAKE-12345");
  await page.screenshot({ path: `${SHOTS}/cli-login-1440.png`, fullPage: true });
  await expect(cli.getByText("signed in", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("cell", { name: "Dev", exact: true }).click();
  await page.getByLabel("Title").fill("Square by Claude Code");
  await page.getByLabel("Brief").fill("Give the square fix to Claude Code.");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("region", { name: "Report" }).getByText("Claude Code fixed square.")).toBeVisible({ timeout: 30_000 });
  const tree = page.getByRole("region", { name: "Agent tree" });
  await expect(tree.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(tree.getByText("≈$0.07 subscription")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/cli-tree-1440.png`, fullPage: true });
  await tree.getByRole("link", { name: "Claudia", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claudia" })).toBeVisible();
  await expect(page.getByText("At API prices (subscription)")).toBeVisible();
  await expect(page.getByRole("region", { name: "Report" }).getByText("square multiplies now.")).toBeVisible();
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByText("Write", { exact: false }).first()).toBeVisible();
  await expect(timeline.getByText("pushed", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/cli-run-1440.png`, fullPage: true });

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(cli.getByRole("meter", { name: "5-hour window" })).toHaveAttribute("aria-valuenow", "42");
  await page.screenshot({ path: `${SHOTS}/cli-settings-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/cli-settings-375.png`, fullPage: true });
});

test("set up Linear, a project's profile and local files, and the ports agents may not reach", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  const linear = page.getByRole("region", { name: "Linear" });
  await expect(linear.getByText("not installed")).toBeVisible();
  await expect(linear.getByText("/api/linear/callback")).toBeVisible();
  await linear.getByLabel("Client ID").fill("client-id-e2e");
  await linear.getByLabel("Client secret").fill("client-secret-e2e");
  await linear.getByLabel("Webhook signing secret").fill("webhook-secret-e2e");
  await linear.getByRole("button", { name: "Save" }).click();
  await expect(linear.getByRole("button", { name: "Install in Linear" })).toBeEnabled();
  await expect(linear.getByText("Stored; leave empty to keep it.").first()).toBeVisible();

  const mac = page.getByRole("region", { name: "This Mac" });
  await mac.getByLabel("Local ports agents may not connect to").fill("3000, 5432");
  await mac.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "This Mac" }).getByLabel("Local ports agents may not connect to")).toHaveValue("3000, 5432");
  await page.screenshot({ path: `${SHOTS}/linear-settings-1440.png`, fullPage: true });

  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("button", { name: "Profile and files" }).first().click();
  await page.getByLabel("Test", { exact: true }).fill("node --test");
  await page.getByLabel("Rules").fill("Never deploy; only open pull requests.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByLabel("Path in the repository").fill("Local.xcconfig");
  await page.getByLabel("Content").fill("API_KEY = dev-only\n");
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByRole("cell", { name: "Local.xcconfig" })).toBeVisible();
  await expect(page.getByText("dev-only")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/project-profile-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/project-profile-375.png`, fullPage: true });
  await page.goto("/settings");
  await page.screenshot({ path: `${SHOTS}/linear-settings-375.png`, fullPage: true });
});
