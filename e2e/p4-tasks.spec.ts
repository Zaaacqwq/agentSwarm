import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, SHOTS } from "./support.ts";

// P4 through the UI: a lead from the role template proposes a task, a person approves it on the
// board, creates and drags tasks, and attaches a file in the task channel.
test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/tasks");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("live")).toBeVisible();
}

test("role template, proposal approval, board drag, task drawer and attachments", async ({ page }) => {
  await login(page);

  // A lead from the role template.
  await page.goto("/agents/new");
  await page.getByRole("radio", { name: /Lead/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Lea");
  await page.getByRole("textbox", { name: "Model id", exact: true }).fill("fake/echo-1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Lea" })).toBeVisible();
  await expect(page.locator("label", { hasText: "task_create" }).getByRole("checkbox")).toBeChecked();

  // The lead proposes; the proposal waits for approval on the board.
  await page.getByRole("button", { name: "Chat" }).first().click();
  await expect(page.getByRole("heading", { name: "Lea", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("propose task Polish the docs");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Tasks" }).first().click();
  const backlog = page.getByRole("region", { name: "Backlog" });
  await expect(backlog.getByText("Polish the docs")).toBeVisible({ timeout: 15_000 });
  await expect(backlog.getByText("Proposed by Lea")).toBeVisible();
  await backlog.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("region", { name: "To do" }).getByText("Polish the docs")).toBeVisible();

  // A person's own task opens in the drawer with its task channel.
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator("dialog").getByRole("textbox", { name: "Title", exact: true }).fill("Write the changelog");
  await page.locator("dialog").getByRole("textbox", { name: "Acceptance criteria" }).fill("- lists every PR");
  await page.getByRole("button", { name: "Create task" }).click();
  const drawer = page.getByRole("dialog", { name: /Write the changelog/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: /T-\d+ Write the changelog/ })).toBeVisible();

  // Attach a file in the task channel and download it.
  await drawer.getByLabel("Attach files").click();
  await drawer.locator("input[type=file]").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Changelog\n- PR 1\n") });
  await expect(drawer.getByRole("list", { name: "Attachments to send" }).getByText("notes.md")).toBeVisible();
  await drawer.getByLabel("Message", { exact: true }).fill("draft attached");
  await page.keyboard.press("Enter");
  const file = drawer.getByRole("list", { name: "Attachments" }).getByRole("link", { name: /notes\.md/ });
  await expect(file).toBeVisible();
  const download = await Promise.all([page.waitForEvent("download"), file.click()]).then(([d]) => d);
  expect(download.suggestedFilename()).toBe("notes.md");
  await page.screenshot({ path: `${SHOTS}/08-task-drawer.png` });
  await page.keyboard.press("Escape");

  // Drag the changelog task from To do to In progress.
  const card = page.getByRole("region", { name: "To do" }).getByRole("listitem").filter({ hasText: "Write the changelog" });
  await card.dragTo(page.getByRole("region", { name: "In progress" }));
  await expect(page.getByRole("region", { name: "In progress" }).getByText("Write the changelog")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/09-board.png` });
});
