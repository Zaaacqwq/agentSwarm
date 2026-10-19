import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { DesktopView } from "@agentswarm/contracts";
import { harness, type Harness } from "./harness.ts";
import { CHANNEL, OWNER, until } from "./fake-discord.ts";
import { checkListing, entitlements, isMachO, stageApp, SYSTEM_TOOLS, testBundleId } from "../src/desktop/stage.ts";
import { ACTIONS_PER_LOOK } from "../src/desktop/desktop-service.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const done = (summary: string) => call("report", { summary, tests: "-", unfinished: [] });
const lastText = (c: TranscriptContext) => JSON.stringify(c.messages.at(-1) ?? "");
const seen = (into: string[], next: FauxResponseFactory | ReturnType<typeof call>): FauxResponseFactory => (c, o, s, m) => {
  into.push(lastText(c));
  return typeof next === "function" ? next(c, o, s, m) : next;
};
const DISCORD_TOKEN = `fake-${"x".repeat(60)}`;

/** The root spawns a QA with the desktop and waits; the QA's script is the test's. */
function rootSpawnsQa(h: Harness, qa: (FauxResponseFactory | ReturnType<typeof call>)[], name = "QA") {
  return h.scriptAgents({
    Dev: [call("spawn_agent", { name, role: "qa", brief: "Open the Notes app on the desktop and check that New Note adds a note.", needs: ["desktop"] }), call("wait_agents", {}), done("QA checked it.")],
    [name]: qa,
  });
}

const desktop = async (h: Harness, cookie: string) => (await h.api("GET", "/api/desktop", undefined, cookie)).body as DesktopView;

describe("the desktop (R9): staging an app", () => {
  const MACHO = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)]);
  const signed: string[][] = [];
  const tools = {
    ...SYSTEM_TOOLS,
    codesign: async (args: string[]) => {
      if (args[0] === "-d") return "com.apple.security.app-sandbox";
      signed.push(args);
      return "";
    },
  };
  /** A tiny app, changed by `edit`, packed as a workstation would pack it. */
  function packed(edit: (app: string) => void = () => {}): Buffer {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    try {
      const app = join(dir, "Demo.app");
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(app, "Contents", "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.apple.Terminal</string><key>CFBundleExecutable</key><string>Demo</string><key>LSEnvironment</key><dict><key>DYLD_INSERT_LIBRARIES</key><string>/tmp/x</string></dict></dict></plist>\n');
      writeFileSync(join(app, "Contents", "MacOS", "Demo"), MACHO);
      edit(app);
      execFileSync("/usr/bin/tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "Demo.app"]);
      return readFileSync(join(dir, "a.tgz"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const stage = async (archive: Buffer, app = "Demo.app") => {
    const dir = mkdtempSync(join(tmpdir(), "staged-"));
    try {
      const path = await stageApp({ archive, dir: join(dir, "run"), app, projectSlug: "notes", network: false, tools });
      return { plist: execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", join(path, "Contents", "Info.plist")], { encoding: "utf8" }), exists: (p: string) => existsSync(join(path, p)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("apps run as the project's test id, in the App Sandbox, with network only when allowed", async () => {
    assert.equal(testBundleId("fridgy mac/app"), "dev.agentswarm.test.fridgy-mac-app");
    assert.match(entitlements(false), /app-sandbox<\/key><true\/>/);
    assert.doesNotMatch(entitlements(false), /network\.client/);
    assert.match(entitlements(true), /network\.client<\/key><true\/>/);
    const ok = await stage(packed((app) => {
      mkdirSync(join(app, "Contents", "Frameworks", "A.framework", "Versions", "A"), { recursive: true });
      symlinkSync("A", join(app, "Contents", "Frameworks", "A.framework", "Versions", "Current"));
      mkdirSync(join(app, "Contents", "Library", "LoginItems", "Helper.app"), { recursive: true });
    }));
    assert.match(ok.plist, /dev\.agentswarm\.test\.notes/, "renamed: never the id the agent chose");
    assert.doesNotMatch(ok.plist, /LSEnvironment/, "keys that change how it starts are removed");
    assert.ok(!ok.exists("Contents/Library"), "login items and the like are removed");
    assert.ok(signed.at(-1)!.includes("--deep") && signed.at(-1)!.includes("--entitlements"));
  });

  test("refused: a script as the main program, other apps inside, links out, an app that is a link, paths with ..", async () => {
    await assert.rejects(stage(packed((app) => writeFileSync(join(app, "Contents", "MacOS", "Demo"), "#!/bin/sh\ncat ~/.ssh/id_ed25519\n"))), /not a compiled program/);
    await assert.rejects(stage(packed((app) => mkdirSync(join(app, "Contents", "Resources", "Other.app"), { recursive: true }))), /other apps or extensions/);
    await assert.rejects(stage(packed((app) => symlinkSync("/Users", join(app, "Contents", "home")))), /links that point outside/);
    await assert.rejects(stage(packed((app) => symlinkSync("../../..", join(app, "Contents", "up")))), /links that point outside/);
    // The archive's own app is a link to somewhere else.
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    try {
      symlinkSync(homedir(), join(dir, "Demo.app"));
      execFileSync("/usr/bin/tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "Demo.app"]);
      await assert.rejects(stage(readFileSync(join(dir, "a.tgz"))), /not a folder inside the staging area/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.throws(() => checkListing("-rw-r--r--  0 a b 4 Oct 19 14:25 Demo.app/../../x", "Demo.app"), /\.\./);
    assert.throws(() => checkListing("-rw-r--r--  0 a b 4 Oct 19 14:25 Other.app/x", "Demo.app"), /more than the app/);
    assert.throws(() => checkListing("hrw-r--r--  0 a b 0 Oct 19 14:25 Demo.app/x link to Demo.app/y", "Demo.app"), /not a file, folder or link/);
    assert.throws(() => checkListing(`-rw-r--r--  0 a b ${600 * 1024 * 1024} Oct 19 14:25 Demo.app/big`, "Demo.app"), /too large/);
    assert.equal(isMachO(process.execPath), true);
  });
});

describe("the desktop (R9): sessions", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("a QA asks, you approve, it builds and opens the app in the sandbox, looks before it acts, and releases", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    const results: string[] = [];
    rootSpawnsQa(h, [
      (c) => {
        results.push(JSON.stringify(c.messages[0]));
        return call("desktop_request", { purpose: "Check that New Note adds a note", minutes: 10 });
      },
      seen(results, call("desktop_open", { scheme: "Demo", project: "App.xcodeproj" })),
      seen(results, call("desktop_look", { save_as: "docs/screens/01-main.jpg" })),
      seen(results, call("desktop_click", { element: 1 })),
      seen(results, call("desktop_type", { text: "Milk" })),
      seen(results, call("desktop_key", { combo: "cmd+s" })),
      seen(results, call("desktop_key", { combo: "return" })),
      seen(results, call("desktop_look", {})),
      seen(results, call("desktop_key", { combo: "cmd+tab" })),
      seen(results, call("desktop_release", {})),
      seen(results, done("New Note adds a note. Screenshot: docs/screens/01-main.jpg")),
    ]);
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Notes", brief: "Have QA check the Notes app." }, cookie)).body;
    await until(() => h.services.desktop.view().sessions[0]?.status === "pending", 30_000);
    const [asked] = (await desktop(h, cookie)).sessions;
    assert.deepEqual([asked!.agent, asked!.minutes, asked!.purpose], ["QA", 10, "Check that New Note adds a note"]);
    assert.match(results[0]!, /desktop_request/, "the QA has the desktop tools");
    assert.equal(h.desktop.calls.filter((c) => c.cmd === "arm").length, 0, "nothing is armed before you approve");

    assert.equal((await h.api("POST", `/api/desktop/sessions/${asked!.id}/approve`, {}, cookie)).status, 200);
    await until(() => h.services.runs.get(run.id).status === "succeeded", 60_000);
    // It built for macOS, and swarmd signed it for the App Sandbox with the project's test id before the helper opened it.
    assert.match(results[1]!, /approved your desktop session: 10 minutes/);
    assert.match(results[2]!, /opened Demo/);
    const sign = h.signed[0]!;
    assert.ok(sign.includes("--deep") && sign.includes("--entitlements") && sign.at(-1)!.startsWith(h.appsDir), JSON.stringify(sign));
    const open = h.desktop.calls.find((c) => c.cmd === "open")!;
    assert.ok(String(open.path).startsWith(h.appsDir) && String(open.path).endsWith("Demo.app"));
    assert.match(String(open.user), /^ws-\d+$/, "it runs as the run's workstation user");
    // Looking: the picture to the model and the dashboard, and as evidence in the worktree.
    assert.match(results[3]!, /New Note/);
    assert.match(results[3]!, /"type":"image"/);
    const qaRun = h.services.runs.list().find((r) => r.title === "QA")!;
    assert.equal(readdirSync(join(h.base, "screens", qaRun.id)).length, 2);
    // Three actions after a look; the fourth must look first. Switching apps is refused.
    assert.match(results[6]!, /Done/);
    assert.match(results[7]!, new RegExp(`Look first \\(desktop_look\\): at most ${ACTIONS_PER_LOOK} actions`));
    assert.match(results[9]!, /cmd\+tab is off limits/);
    // Released: the helper is disarmed, the app closed, the staged copy gone.
    assert.match(results[10]!, /Released/);
    assert.ok(h.desktop.calls.some((c) => c.cmd === "disarm"));
    assert.ok(!existsSync(join(h.appsDir, qaRun.id)));
    assert.deepEqual((await desktop(h, cookie)).sessions, []);
  });

  test("one at a time: the second waits in a queue; you decline, Discord asks for the next with buttons, and Stop on the Mac ends it", async () => {
    h = await harness({ maxConcurrentRuns: 3 });
    const { cookie, agentId } = await h.ready();
    assert.equal((await h.api("PUT", "/api/discord", { token: DISCORD_TOKEN, channelId: CHANNEL, ownerId: OWNER }, cookie)).status, 200);
    const a: string[] = [];
    const b: string[] = [];
    h.scriptAgents({
      Dev: [
        call("spawn_agent", { name: "QA1", role: "qa", brief: "Check the settings window of the app on the desktop.", needs: ["desktop"] }),
        call("spawn_agent", { name: "QA2", role: "qa", brief: "Check the main window of the app on the desktop.", needs: ["desktop"] }),
        call("wait_agents", {}), done("Both done."),
      ],
      QA1: [call("desktop_request", { purpose: "Check the settings window" }), seen(a, done("Could not check: declined."))],
      QA2: [
        call("desktop_request", { purpose: "Check the main window" }),
        seen(b, call("desktop_open", { scheme: "Demo", project: "App.xcodeproj" })),
        // You are using the Mac: the click waits, and you press Stop meanwhile.
        seen(b, () => {
          h.desktop.pauseFor(3000);
          return call("desktop_click", { element: 1 });
        }),
        seen(b, done("Stopped before the check.")),
      ],
    });
    await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Two", brief: "Check both windows." }, cookie);
    await until(() => h.services.desktop.view().sessions.length === 2, 30_000);
    const [first, second] = (await desktop(h, cookie)).sessions;
    assert.deepEqual([first!.status, second!.status], ["pending", "queued"]);
    assert.equal((await h.api("POST", `/api/desktop/sessions/${second!.id}/approve`, {}, cookie)).status, 409, "a queued request cannot be approved yet");
    const ask = h.discord.sent.find((s) => s.buttons.some((x) => x.id === `desktop-approve:${first!.id}`))!;
    assert.match(ask.content, /asks to use this Mac's desktop for 15 minutes/);

    // You decline the first in Discord; the second asks.
    await h.discord.click(`desktop-deny:${first!.id}`, CHANNEL);
    await until(() => a.length === 1, 30_000);
    assert.match(a[0]!, /declined your desktop session/);
    await until(() => h.discord.sent.some((s) => s.buttons.some((x) => x.id === `desktop-approve:${second!.id}`)));
    await h.discord.click(`desktop-approve:${second!.id}`, CHANNEL);
    await until(() => b.length >= 1, 30_000);
    await until(() => h.services.desktop.view().sessions[0]?.app === "Demo", 30_000);

    // You press Stop in the menu bar: swarmd notices, ends the session, and confirms the Stop to the helper.
    h.desktop.stopOnMac();
    await h.services.desktop.refresh();
    await until(() => b.length === 3, 30_000);
    assert.match(b[2]!, /Your desktop session has ended: you stopped it on the Mac/, "the agent is told at once");
    assert.ok(h.desktop.calls.some((c) => c.cmd === "ack_stop"));
    assert.deepEqual((await desktop(h, cookie)).sessions, []);
    // Let the root hear back and finish before the harness closes.
    await until(() => h.services.runs.list().every((r) => ["succeeded", "failed", "cancelled"].includes(r.status)), 30_000);
  });

  test("while you use the Mac the agent's input waits; a missing helper is said plainly; a cancelled run withdraws its request", async () => {
    h = await harness();
    const { cookie, agentId } = await h.ready();
    const results: string[] = [];
    rootSpawnsQa(h, [
      call("desktop_request", { purpose: "Check the main window" }),
      seen(results, call("desktop_open", { scheme: "Demo", project: "App.xcodeproj" })),
      seen(results, call("desktop_look", {})),
      seen(results, () => {
        h.desktop.pauseFor(1200);
        return call("desktop_click", { element: 2 });
      }),
      seen(results, done("Checked.")),
    ]);
    h.desktop.installed = false;
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Pause", brief: "Have QA check it." }, cookie)).body;
    await until(() => h.services.desktop.view().sessions[0]?.status === "pending", 30_000);
    const [s] = (await desktop(h, cookie)).sessions;
    assert.equal((await desktop(h, cookie)).helper.running, false);
    const refused = await h.api("POST", `/api/desktop/sessions/${s!.id}/approve`, {}, cookie);
    assert.deepEqual([refused.status, /setup-desktop\.sh/.test(refused.body.message ?? refused.body.error ?? "")], [409, true], JSON.stringify(refused.body));
    h.desktop.installed = true;
    await h.api("POST", `/api/desktop/sessions/${s!.id}/approve`, {}, cookie);
    await until(() => h.services.runs.get(run.id).status === "succeeded", 60_000);
    assert.match(results[3]!, /Done \(waited \d+ s while the person used the Mac\)|Done/);

    // A request whose run is cancelled is withdrawn.
    rootSpawnsQa(h, [call("desktop_request", { purpose: "Check it again" })], "QA");
    const again = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Again", brief: "Have QA check it again." }, cookie)).body;
    await until(() => h.services.desktop.view().sessions[0]?.status === "pending", 30_000);
    await h.api("POST", `/api/runs/${again.id}/cancel`, {}, cookie);
    await until(() => h.services.desktop.view().sessions.length === 0, 30_000);
  });
});

