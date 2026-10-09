import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, SHOTS } from "./support.ts";

// P5 through the UI: an operator's question arrives as an approval card in the chat and on the
// banner, a person answers or declines it, and the "This Mac" view explains the desktop helper.
test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/chat");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("live")).toBeVisible();
}

test("approval cards, banner, desktop view and browser profile", async ({ page }) => {
  await login(page);

  await page.goto("/agents/new");
  await page.getByRole("radio", { name: /Operator/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Quinn");
  await page.getByRole("textbox", { name: "Model id", exact: true }).fill("fake/echo-1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Quinn" })).toBeVisible();
  await expect(page.locator("label", { hasText: "browser_open" }).getByRole("checkbox")).toBeChecked();
  await expect(page.locator("label", { hasText: "ask_human" }).getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("region", { name: "Browser" }).getByText("not used yet")).toBeVisible();

  // The question blocks the agent and shows up in the chat and on the banner.
  await page.getByRole("button", { name: "Chat" }).first().click();
  await page.getByLabel("Message", { exact: true }).fill("ask me Deploy the landing page now?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("list", { name: "Messages" }).getByRole("article", { name: "Question request from Quinn" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Deploy the landing page now?")).toBeVisible();
  const banner = page.getByRole("region", { name: "Waiting for you" });
  await expect(banner.getByText("An agent is waiting for you")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-approval-card.png` });
  await card.getByRole("button", { name: "Yes" }).click();
  await expect(card.getByText("admin answered:")).toBeVisible();
  await expect(card.getByText("Yes", { exact: true })).toBeVisible();
  await expect(banner).toBeHidden();

  // Declining from the banner settles the card in the chat too.
  await page.getByLabel("Message", { exact: true }).fill("ask me Rename the repository?");
  await page.keyboard.press("Enter");
  await expect(banner.getByText("Rename the repository?")).toBeVisible({ timeout: 15_000 });
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  const second = page.getByRole("list", { name: "Messages" }).getByRole("article").filter({ hasText: "Rename the repository?" });
  await expect(second.getByText("Declined by admin")).toBeVisible();

  // This Mac: without the helper installed, the view says how to install it.
  await page.getByRole("link", { name: "Workstations" }).first().click();
  await page.getByRole("tab", { name: "This Mac" }).click();
  await expect(page).toHaveURL(/view=desktop/);
  await expect(page.getByText("Hive Desktop is not running.")).toBeVisible();
  await expect(page.getByText("Nobody is controlling this Mac.")).toBeVisible();
  await expect(page.getByText("Screen Recording")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11-this-mac.png` });
});
