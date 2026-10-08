import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

// P1 acceptance through the real UI: setup, endpoint, two agents, separate DMs,
// replies via send_message, state surviving a reload, and the activity inspector.
const MODEL_URL = "http://127.0.0.1:4391/v1";
const password = `e2e-${randomBytes(8).toString("hex")}`;
const shots = ".tmp/e2e-results/screens";
const log = (page: Page) => page.getByRole("list", { name: "Messages" });

test.describe.configure({ mode: "serial" });

async function createAgent(page: Page, name: string, role: string) {
  await page.goto("/agents/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Role").fill(role);
  await page.getByLabel("Model id").fill("fake/echo-1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/agt_/);
}

async function chatWith(page: Page, name: string, text: string) {
  await page.getByRole("link", { name: "Chat" }).first().click();
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("button", { name }).click();
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.keyboard.press("Enter");
  await expect(log(page).getByText(`You said ${text}.`)).toBeVisible({ timeout: 15_000 });
}

test("admin sets up Hive, creates two agents, and chats with each", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up your hive" })).toBeVisible();
  await page.screenshot({ path: `${shots}/01-setup.png` });
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByText("live")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await page.getByLabel("Kind").selectOption("openai-compatible");
  await page.getByLabel("Base URL").fill(MODEL_URL);
  await page.getByLabel("API key").fill("local-fake-key");
  await page.getByRole("button", { name: "Save endpoint" }).click();
  await expect(page.getByText(MODEL_URL)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("local-fake-key");

  await createAgent(page, "Ada", "Research lead");
  await page.screenshot({ path: `${shots}/02-agent-editor.png`, fullPage: true });
  await createAgent(page, "Bob", "Builder");

  await chatWith(page, "Ada", "alpha73");
  await page.screenshot({ path: `${shots}/03-chat-ada.png` });
  await chatWith(page, "Bob", "beta84");
  await expect(log(page).getByText("You said alpha73.")).toHaveCount(0);

  // Refreshing is only re-observation: history and agents are still there.
  await page.reload();
  await expect(log(page).getByText("You said beta84.")).toBeVisible();
  await page.getByRole("link", { name: /Ada/ }).first().click();
  await expect(log(page).getByText("You said alpha73.")).toBeVisible();

  await page.getByRole("link", { name: "Agent settings" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("succeeded").first()).toBeVisible();
  await expect(page.getByText("→ send_message").first()).toBeVisible();
  await page.screenshot({ path: `${shots}/04-activity.png` });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("link", { name: "Chat" }).last().click();
  await expect(page.getByRole("link", { name: /Bob/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Bob/ })).toContainText("You said beta84.");
  await page.screenshot({ path: `${shots}/05-mobile-list.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a fresh login is required after logout", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Model endpoints" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});
