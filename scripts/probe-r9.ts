// R9.0: checks on the real Mac, with agentSwarm Desktop installed and granted. Opens an app on your screen.
//   node scripts/probe-r9.ts <path to a built .app> [--watch]
// Stages the app as swarmd would (renamed, App Sandbox, ad hoc signed), opens it in a short session, looks at it,
// prints what it shows (the probe app prints what the sandbox let it do), and with --watch asks you to move the
// mouse to check the pause. The session is always ended at the end.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SocketHelper, type HelperStatus } from "../apps/swarmd/src/desktop/helper.ts";
import { stageApp } from "../apps/swarmd/src/desktop/stage.ts";

const app = process.argv[2];
if (!app?.endsWith(".app") || !existsSync(app)) throw new Error("Give the path of a built .app");
const support = join(homedir(), "Library", "Application Support", "agentSwarm");
const helper = new SocketHelper(join(support, "desktop.sock"));
const marker = join(support, "probe-escaped");
const out = join(process.cwd(), "test-results", "probe-r9");
mkdirSync(out, { recursive: true });
rmSync(marker, { force: true });

const status = await helper.call<HelperStatus>({ cmd: "status" });
console.log("helper:", JSON.stringify(status));
if (!status.screenRecording || !status.accessibility) throw new Error("Grant Screen Recording and Accessibility first");

const work = mkdtempSync(join(tmpdir(), "probe-r9-"));
execFileSync("/usr/bin/tar", ["-czf", join(work, "app.tgz"), "-C", dirname(app), basename(app)]);
const staged = await stageApp({ archive: readFileSync(join(work, "app.tgz")), dir: join(support, "apps", "probe-r9"), app: basename(app), projectSlug: "probe", network: false });
rmSync(work, { recursive: true, force: true });
console.log("staged:", staged);
console.log(execFileSync("/usr/bin/codesign", ["-d", "--entitlements", "-", staged], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

const session = randomBytes(24).toString("hex");
try {
  if (status.stoppedByUser) await helper.call({ cmd: "ack_stop" });
  await helper.call({ cmd: "arm", untilMs: Date.now() + 5 * 60_000, holder: "R9 probe", session });
  const opened = await helper.call<{ pid: number; name: string; inFront: boolean }>({ cmd: "open", session, path: staged }, 60_000);
  console.log("opened:", JSON.stringify(opened));
  // The probe app needs a while (its network attempt has to fail first).
  let look = await helper.call<{ image: string; width: number; height: number; ui: string }>({ cmd: "look", session }, 30_000);
  for (let i = 0; i < 30 && !look.ui.includes("\"done\""); i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    look = await helper.call({ cmd: "look", session }, 30_000);
  }
  writeFileSync(join(out, "look.jpg"), Buffer.from(look.image, "base64"));
  console.log(`look: ${look.width}x${look.height}, saved ${join(out, "look.jpg")}\n${look.ui}`);
  console.log("escape through Terminal:", existsSync(marker) ? "ESCAPED (marker written)" : "no marker");
  // Input waits while you use the Mac: wait for a quiet moment before trying it.
  for (let i = 0; i < 40 && (await helper.call<HelperStatus>({ cmd: "status" })).armed?.pausedUntilMs; i++) await new Promise((r) => setTimeout(r, 1_500));
  // Clicks are given in the look's coordinates: there is no way to name a point outside the app's windows.
  const outside = await helper.call({ cmd: "click", session, x: look.width + 50, y: 10 }).then(() => "allowed", (e: Error) => `refused: ${e.message}`);
  console.log("click beyond its windows:", outside);
  // Our own click must not count as you using the Mac.
  const clicked = await helper.call({ cmd: "click", session, x: Math.round(look.width / 2), y: Math.round(look.height / 2) }).then(() => "done", (e: Error) => `refused: ${e.message}`);
  const after = (await helper.call<HelperStatus>({ cmd: "status" })).armed?.pausedUntilMs;
  console.log("click in the app:", clicked, "| paused afterwards:", after ? "YES (wrong)" : "no");
  const tab = await helper.call({ cmd: "key", session, combo: "cmd+tab" }).then(() => "allowed", (e: Error) => `refused: ${e.message}`);
  console.log("cmd+tab:", tab);
  if (process.argv.includes("--watch")) {
    console.log("Move the mouse now (10 s)…");
    const until = Date.now() + 10_000;
    let paused: number | null = null;
    while (Date.now() < until && !paused) {
      await new Promise((r) => setTimeout(r, 500));
      paused = (await helper.call<HelperStatus>({ cmd: "status" })).armed?.pausedUntilMs ?? null;
    }
    console.log("pause:", paused ? `paused until ${new Date(paused).toLocaleTimeString()}` : "NOT NOTICED");
    const typed = await helper.call({ cmd: "type", session, text: "x" }).then(() => "allowed", (e: Error) => `refused: ${e.message}`);
    console.log("typing while you use the Mac:", typed);
  }
} finally {
  await helper.call({ cmd: "disarm", session }).catch(() => undefined);
  rmSync(join(support, "apps", "probe-r9"), { recursive: true, force: true });
  rmSync(marker, { force: true });
  console.log("session ended");
}
