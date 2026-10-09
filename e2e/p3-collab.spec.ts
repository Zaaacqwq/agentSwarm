import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, SHOTS } from "./support.ts";

// P3 through the UI with the fake model: groups wake only mentioned agents, replies,
// reactions, an agent-to-agent DM that people can only read, and ⌘K search.
test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/chat");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("live")).toBeVisible();
}

const log = (page: Page) => page.getByRole("list", { name: "Messages" });

test("groups, mentions, replies, reactions, agent DMs and search", async ({ page }) => {
  await login(page);

  // Let Ada message colleagues.
  await page.getByRole("link", { name: "Agents" }).first().click();
  await page.getByRole("link", { name: /Ada/ }).first().click();
  await page.locator("label", { hasText: "Colleagues" }).first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

  // Create a group with both agents.
  await page.getByRole("link", { name: "Chat" }).first().click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.locator("dialog").getByRole("textbox", { name: "Name", exact: true }).fill("Crew");
  await page.locator("dialog label", { hasText: "Ada" }).getByRole("checkbox").check();
  await page.locator("dialog label", { hasText: "Bob" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("heading", { name: "Crew" })).toBeVisible();

  // @mention autocomplete, then only Bob answers.
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("status please @Bo");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue("status please @Bob ");
  await page.keyboard.press("Enter");
  await expect(log(page).getByText("You said status please @Bob.")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await expect(log(page).getByText(/^Bob ·/)).toHaveCount(1);
  await expect(log(page).getByText(/^Ada ·/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/06-group.png` });

  // Reply to Bob's message and react to it.
  const bobBubble = log(page).locator("[id^=msg-]").filter({ hasText: "You said status please" }).first();
  await bobBubble.hover();
  await bobBubble.getByRole("button", { name: "Reply" }).click();
  await expect(page.getByText("Replying to")).toBeVisible();
  await box.fill("thanks");
  await page.keyboard.press("Enter");
  await expect(log(page).getByRole("link", { name: /Bob: Got it/ })).toBeVisible();
  await bobBubble.hover();
  await bobBubble.getByRole("button", { name: "Add reaction" }).click();
  await page.getByRole("button", { name: "React 🎉" }).click();
  await expect(bobBubble.getByRole("button", { name: /🎉 1/ })).toBeVisible();

  // Ada relays to Bob through an agent DM, which people can read but not write.
  await page.getByRole("button", { name: "DM" }).click();
  await page.getByRole("button", { name: "Ada" }).click();
  await expect(page.getByRole("heading", { name: "Ada", exact: true })).toBeVisible();
  await box.fill("relay to Bob");
  await page.keyboard.press("Enter");
  const between = page.getByRole("region", { name: "Between agents" });
  await expect(between.getByRole("link")).toHaveCount(1, { timeout: 15_000 });
  await between.getByRole("link").first().click();
  await expect(log(page).getByText("relayed from the owner")).toBeVisible();
  await expect(page.getByText("You can read along but not post")).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);

  // ⌘K finds the group message and jumps to it.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search" }).fill("status please");
  const hit = page.getByRole("option").filter({ hasText: "in Crew" }).first();
  await expect(hit).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/07-portal.png` });
  await hit.click();
  await expect(page).toHaveURL(/\/chat\/ch_.*\?m=\d+/);
  await expect(page.getByRole("heading", { name: "Crew" })).toBeVisible();
});
