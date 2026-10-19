import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const SHOTS = "test-results/screens";

test("set up agentSwarm, add a project and an agent, and watch a run fix a bug", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "agentSwarm" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("API key").fill("sk-or-e2e-key-value");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(page.getByText("key stored")).toBeVisible();
  await page.getByLabel("Fine-grained token").fill("github_pat_e2e_token_value_123456");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByText("tester")).toBeVisible();

  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByLabel("Or type it").fill("tester/demo");
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
  await expect(timeline.locator(".tool-card.ok", { hasText: "ws_bash" }).first()).toBeVisible();
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
  const shot = page.getByRole("region", { name: "Timeline" }).getByRole("img", { name: "Screenshot from sim_screenshot" });
  await expect(shot).toBeVisible();
  await expect.poll(() => shot.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
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
  // One live feed for the whole tree: the builder's tool calls, as cards that open.
  const activity = page.getByRole("log", { name: "Agent activity" });
  await expect(activity.locator(".agent-chip", { hasText: "Builder" }).first()).toBeVisible();
  const card = activity.locator(".tool-card", { hasText: "cube.js" }).first();
  await expect(card).toBeVisible();
  await card.locator("summary").click();
  await expect(card.getByText("export const cube")).toBeVisible();
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

test("the board's limit, the backup model, a project's profile and local files, and the ports agents may not reach", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Linear" })).toHaveCount(0);
  const board = page.getByRole("region", { name: "Tickets" });
  await board.getByLabel("Tickets worked on at once").fill("2");
  await board.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "Tickets" }).getByLabel("Tickets worked on at once")).toHaveValue("2");

  const backup = page.getByRole("region", { name: "Backup model" });
  await expect(backup.getByText("None yet")).toBeVisible();
  await backup.getByLabel("Backup model").fill("anthropic/claude-haiku-5-5");
  await backup.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "Backup model" }).getByText("anthropic/claude-haiku-5-5", { exact: true })).toBeVisible();

  const mac = page.getByRole("region", { name: "This Mac" });
  await expect(mac.getByText("simulators and browsers in use", { exact: false })).toBeVisible();
  await mac.getByLabel("Local ports agents may not connect to").fill("3000, 5432");
  await mac.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "This Mac" }).getByLabel("Local ports agents may not connect to")).toHaveValue("3000, 5432");
  await page.screenshot({ path: `${SHOTS}/settings-1440.png`, fullPage: true });

  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("button", { name: "Profile and files" }).first().click();
  await page.getByLabel("Test", { exact: true }).fill("node --test");
  await page.getByLabel("Rules").fill("Never deploy; only open pull requests.");
  await page.getByLabel("iOS scheme").fill("Demo");
  await page.getByLabel("Xcode project or workspace").fill("Demo.xcodeproj");
  await page.getByLabel("Test sites").fill("https://staging.example.com");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Profile and files" }).first().click();
  await expect(page.getByLabel("iOS scheme")).toHaveValue("Demo");
  await expect(page.getByLabel("Test sites")).toHaveValue("https://staging.example.com");
  await page.getByLabel("Path in the repository").fill("Local.xcconfig");
  await page.getByLabel("Content").fill("API_KEY = dev-only\n");
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByRole("cell", { name: "Local.xcconfig" })).toBeVisible();
  await expect(page.getByText("dev-only")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/project-profile-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/project-profile-375.png`, fullPage: true });
  await page.goto("/settings");
  await page.screenshot({ path: `${SHOTS}/settings-375.png`, fullPage: true });
});

test("the board: a ticket with a picture, dragged into Todo, answered on the phone, and stopped", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();
  await page.getByRole("button", { name: "New ticket" }).click();
  const form = page.getByRole("region", { name: "New ticket" });
  await form.getByLabel("Title").fill("Make the button orange");
  await form.getByLabel("Details").fill("The main button is grey; it should stand out.");
  await form.getByRole("button", { name: "Change a project" }).click();
  await form.getByLabel("Priority").selectOption("2");
  await form.getByLabel("Pictures").setInputFiles({ name: "button.png", mimeType: "image/png", buffer: PNG });
  await expect(form.getByRole("img", { name: "button.png" })).toBeVisible();
  await form.getByRole("button", { name: "Add to the backlog" }).click();
  await expect(page.getByRole("heading", { name: "Make the button orange" })).toBeVisible();
  await expect(page.getByRole("img", { name: "button.png" })).toBeVisible();
  await page.getByRole("link", { name: "Tickets" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const card = page.getByRole("article", { name: /DEM-\d+ Make the button orange/ });
  await page.goto("/?view=board");
  await expect(page.getByRole("region", { name: "Backlog" }).getByRole("article")).toHaveCount(1);
  // Two more in the backlog, then a drag within the column: the last one goes to the top.
  for (const title of ["Second idea", "Third idea"]) {
    await page.evaluate(`fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space: "ideas", kind: "research", title: "${title}", description: "" }) })`);
  }
  const backlog = page.getByRole("region", { name: "Backlog" });
  await expect(backlog.getByRole("article")).toHaveCount(3);
  const titles = () => backlog.locator(".ticket-title").allTextContents();
  const order = await titles();
  const last = backlog.getByRole("article").nth(2);
  const top = backlog.getByRole("article").nth(0);
  const from = (await last.boundingBox())!;
  const dest = (await top.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(from.x + 24, from.y + 2, { steps: 3 });
  await page.mouse.move(dest.x + 20, dest.y + 4, { steps: 12 });
  await page.mouse.up();
  await expect.poll(titles).toEqual([order[2], order[0], order[1]]);
  await page.reload();
  await expect.poll(titles).toEqual([order[2], order[0], order[1]]);
  await page.screenshot({ path: `${SHOTS}/board-1440.png`, fullPage: true });
  // Drag it into Todo: it starts, its lead asks, and it lands in Needs you.
  const box = (await card.boundingBox())!;
  const todo = (await page.getByRole("region", { name: "Todo" }).boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 30, { steps: 4 });
  await page.mouse.move(todo.x + todo.width / 2, todo.y + 60, { steps: 12 });
  await page.mouse.up();
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs.getByText("Answer the lead")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/board-needs-you-1440.png`, fullPage: true });

  // On a phone: the list, the ticket, the question, the answer.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/?view=list");
  await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/board-list-375.png`, fullPage: true });
  await page.getByRole("link", { name: "Make the button orange" }).click();
  const chat = page.getByRole("region", { name: "Conversation" });
  await expect(chat.getByText("Which colour should the button be?")).toBeVisible();
  await expect(page.getByText("Answer the lead").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ticket-375.png`, fullPage: true });
  await page.getByLabel("Your answer").fill("Orange, like the logo.");
  await page.getByRole("button", { name: "Answer" }).click();
  await expect(chat.getByText("Got it: orange. Anything else?")).toBeVisible({ timeout: 30_000 });
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as number;
  expect(overflow).toBeLessThanOrEqual(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/ticket-375-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

test("memory: an agent's lesson approved and pinned, a lesson of your own, a handbook change accepted and a handbook edited", async ({ page }) => {
  await page.goto("/memory");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(page.getByText("1 handbook change to decide")).toBeVisible();
  const lesson = page.getByRole("article", { name: "SwiftUI projects: build with sim_build, not plain swiftc" });
  await expect(lesson.getByText("advice from Lead after FRI-3")).toBeVisible();
  await expect(page.getByRole("heading", { name: /waiting for you/ })).toBeVisible();
  await lesson.getByRole("button", { name: "Pin" }).waitFor({ state: "detached" });
  await lesson.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: /waiting for you/ })).toHaveCount(0);
  await lesson.getByRole("button", { name: "Pin" }).click();
  await expect(lesson.getByText("Pinned", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New lesson" }).click();
  const form = page.getByRole("region", { name: "New lesson" });
  await form.getByLabel("Title").fill("betterUWWorks: dev servers on port 3100");
  await form.getByLabel("Lesson").fill("3000 is the live site and is blocked.");
  await form.getByRole("button", { name: "Keep this lesson" }).click();
  await expect(page.getByRole("article", { name: "betterUWWorks: dev servers on port 3100" }).getByText("yours")).toBeVisible();
  await page.getByLabel("Search lessons").fill("swiftui");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/memory-lessons-1440.png`, fullPage: true });

  await page.getByRole("tab", { name: /Handbooks/ }).click();
  const proposals = page.getByRole("region", { name: "Changes agents propose" });
  await expect(proposals.getByText("Check the dark theme as well as the light one.")).toBeVisible();
  await proposals.getByRole("button", { name: "Accept…" }).click();
  await expect(proposals.getByText(/exactly as every QA will read it/)).toBeVisible();
  await proposals.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("region", { name: "Changes agents propose" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Roles" }).getByRole("button", { name: /QA/ }).click();
  const qa = page.getByLabel("QA handbook");
  await expect(qa).toHaveValue(/- Check the dark theme as well as the light one\.$/);
  await qa.fill(`${await qa.inputValue()}\n- Try the app with no network.`);
  await page.getByRole("button", { name: "Save handbook" }).click();
  await expect(page.getByText("Earlier versions (2)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/memory-handbooks-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/memory-handbooks-375.png`, fullPage: true });
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as number;
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the desktop: an agent asks to use this Mac, you approve it, it pauses while you use the Mac, and you stop it", async ({ page }) => {
  await page.goto("/agents");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("cell", { name: "Dev", exact: true }).click();
  await page.getByLabel("Title").fill("Check the Notes app");
  await page.getByLabel("Brief").fill("Have a tester check New Note on the desktop.");
  await page.getByRole("button", { name: "Start run" }).click();
  const bar = page.getByRole("region", { name: "Desktop" });
  await expect(bar.getByRole("heading", { name: "Tester asks to use this Mac for 10 minutes" })).toBeVisible({ timeout: 30_000 });
  await expect(bar.getByText("“Check that New Note adds a note”")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-ask-1440.png` });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/desktop-ask-375.png` });
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as number;
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1440, height: 900 });

  await bar.getByRole("button", { name: "Approve" }).click();
  await expect(bar.getByRole("heading", { name: "Tester is testing Demo on this Mac" })).toBeVisible({ timeout: 30_000 });
  await expect(bar.getByText(/Paused while you use the Mac/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/desktop-active-1440.png` });
  await bar.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("region", { name: "Desktop" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Report" })).toBeVisible({ timeout: 30_000 });
});

test("R10: a quick test with your file hands back its result; a ticket waits for another; a change is commented on, sent back and merged", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();

  // A quick test with a file: the lead reads it under inputs/ and hands back outputs/.
  await page.getByRole("button", { name: "New ticket" }).click();
  const form = page.getByRole("region", { name: "New ticket" });
  await form.getByRole("button", { name: "Quick test" }).click();
  await form.getByLabel("Title").fill("Do the assignment");
  await form.getByLabel("Details").fill("Answer the question in notes.txt.");
  await form.getByLabel("Files").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Add 2 and 3.\n") });
  await expect(form.getByRole("list", { name: "Chosen files" }).getByText("notes.txt")).toBeVisible();
  await form.getByRole("checkbox", { name: /Start it/ }).check();
  await form.getByRole("button", { name: "Create and start" }).click();
  await expect(page.getByRole("heading", { name: "Do the assignment" })).toBeVisible();
  const handed = page.getByRole("region", { name: "What it handed back" });
  await expect(handed.getByRole("link", { name: "outputs/answer.md" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "notes.txt" })).toBeVisible();
  const zip = await page.request.get(await handed.getByRole("link", { name: "Download all (zip)" }).getAttribute("href") ?? "");
  expect([zip.status(), (await zip.body()).subarray(0, 2).toString("latin1")]).toEqual([200, "PK"]);
  const answer = await page.request.get(await handed.getByRole("link", { name: "outputs/answer.md" }).getAttribute("href") ?? "");
  expect(await answer.text()).toContain("2 + 3 = 5");
  await page.screenshot({ path: `${SHOTS}/quick-result-1440.png`, fullPage: true });
  const quickKey = new URL(page.url()).pathname.split("/").pop()!;

  // Another ticket waits for it.
  await page.evaluate(`fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space: "sandbox", kind: "quick", title: "Write it up", description: "" }) }).then((r) => r.json()).then((t) => { location.href = "/tickets/" + t.key; })`);
  await expect(page.getByRole("heading", { name: "Write it up" })).toBeVisible();
  await page.getByLabel("Wait for a ticket").selectOption({ label: `${quickKey} Do the assignment` });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: `Stop waiting for ${quickKey}` })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/tickets/${new URL(page.url()).pathname.split("/").pop()}`)).json()).blockedBy).toEqual([quickKey]);
  await page.goto("/?view=board");
  await expect(page.getByRole("article", { name: /Write it up/ }).getByText(`Waits for ${quickKey}`)).toBeVisible();

  // You finish the quick test.
  await page.goto(`/tickets/${quickKey}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // A change in review: a comment on a line, sent back, then merged here.
  await page.evaluate(`fetch("/api/projects").then((r) => r.json()).then((ps) => fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space: "project", projectId: ps.find((p) => p.githubRepo === "tester/demo").id, kind: "change", title: "square adds", description: "square(3) must be 9.", status: "todo" }) })).then((r) => r.json()).then((t) => { location.href = "/tickets/" + t.key; })`);
  await expect(page.getByRole("heading", { name: "square adds" })).toBeVisible();
  const review = page.getByRole("region", { name: "The change" });
  await expect(review.getByRole("button", { name: "Merge" })).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText("math.js", { exact: true })).toBeVisible();
  await review.locator("tr.d-add.commentable").first().click();
  await review.getByLabel("Comment on math.js line 1").fill("Add a doc comment.");
  await review.getByRole("heading", { name: "The change" }).click();
  await expect(review.getByText("💬 Add a doc comment.")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await review.screenshot({ path: `${SHOTS}/review-375.png` });
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") as number;
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await review.getByRole("button", { name: "Send back with 1 comment" }).click();
  await expect(review.getByText("/** Squares a number. */")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole("button", { name: "Merge" })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/review-1440.png`, fullPage: true });
  page.once("dialog", (d) => void d.accept());
  await review.getByRole("button", { name: "Merge" }).click();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

/** A small orange PNG (40×24), built here so the test has no binary fixture. */
const PNG = (() => {
  const w = 40, h = 24;
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const s = Buffer.alloc(4); s.writeUInt32BE(crc(b)); return Buffer.concat([l, b, s]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([0xe8, 0x59, 0x0c], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
})();
