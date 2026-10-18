import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dispatch } from "../src/dispatch.ts";
import { denyPortsFile, sandboxProfile } from "../src/sandbox.ts";
import { PRODUCTION_LAYOUT, type ExecEnv } from "../src/layout.ts";
import type { ImageResult, Request, SimBuildResult, SimDevice, UiElement } from "../src/protocol.ts";
import { compareVersions, deviceName, summarizeBuild } from "../src/ops/sim.ts";
import { addressAllowed, interactAllowed, urlAllowed } from "../src/ops/browser-driver.ts";
import { imageSize } from "../src/ops/image.ts";
import { fixture } from "./fixture.ts";
import { installFakeSim } from "./fake-sim.ts";

async function call<T = Record<string, unknown>>(env: ExecEnv, request: Request): Promise<T> {
  const res = await dispatch(env, request);
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.result as T;
}

const SCOPE = "worktrees/demo/t1--qa";
const clone: Request = { op: "git.clone", scope: SCOPE, mirror: "demo.git", branch: "swarm/demo/t1/qa", base: "main" };
const SHIMS = join(import.meta.dirname, "..", "shims");

describe("building Swift inside the sandbox (R6)", () => {
  test("the profile lets Foundation save files through this user's own temporary-items folder", () => {
    const f = fixture(true);
    try {
      const profile = sandboxProfile(f.env, SCOPE);
      assert.ok(profile.includes(`(allow file-read* file-write* (subpath "${f.layout.volume}/.TemporaryItems/folders.${process.getuid!()}"))`), profile);
      assert.ok(!profile.includes(`(subpath "${f.layout.volume}/.TemporaryItems")`), "not the whole folder");
    } finally {
      f.cleanup();
    }
  });

  test("macros compile with the wrappers on PATH, and not without them", { timeout: 300_000 }, async () => {
    const f = fixture(true);
    try {
      mkdirSync(join(f.layout.toolsDir, "bin"), { recursive: true });
      for (const shim of readdirSync(SHIMS)) copyFileSync(join(SHIMS, shim), join(f.layout.toolsDir, "bin", shim));
      await call(f.env, clone);
      await call(f.env, { op: "fs.write", scope: SCOPE, path: "m.swift", content: "import Observation\n@Observable final class A { var x = 1 }\nprint(A().x)\n" });
      const wrapped = await call<{ exitCode: number; output: string }>(f.env, { op: "exec", scope: SCOPE, command: "swiftc -typecheck m.swift && echo typed", timeoutMs: 240_000 });
      assert.equal(wrapped.exitCode, 0, wrapped.output);
      const bare = await call<{ exitCode: number; output: string }>(f.env, { op: "exec", scope: SCOPE, command: "/usr/bin/swiftc -typecheck m.swift", timeoutMs: 240_000 });
      assert.notEqual(bare.exitCode, 0, "the sandbox really does break macros without the wrapper");
      assert.match(bare.output, /Observable|macro|plugin/i);
      // SwiftPM: the manifest and the macro, through `swift build`.
      await call(f.env, { op: "fs.write", scope: SCOPE, path: "pkg/Package.swift", content: '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", platforms: [.macOS(.v14)], targets: [.executableTarget(name: "P")])\n' });
      await call(f.env, { op: "fs.write", scope: SCOPE, path: "pkg/Sources/P/main.swift", content: "import Observation\n@Observable final class A { var x = 1 }\nprint(A().x)\n" });
      const pkg = await call<{ exitCode: number; output: string }>(f.env, { op: "exec", scope: SCOPE, command: "cd pkg && swift build 2>&1 | tail -3", timeoutMs: 280_000 });
      assert.match(pkg.output, /Build complete/, pkg.output);
      const shim = readFileSync(join(SHIMS, "xcodebuild"), "utf8");
      for (const flag of ["-skipMacroValidation", "-IDEPackageSupportDisableManifestSandbox=YES", "-IDEPackageSupportDisablePluginExecutionSandbox=YES", "OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox"]) assert.ok(shim.includes(flag), flag);
    } finally {
      f.cleanup();
    }
  });

  test("build errors are summarized to the lines that matter", () => {
    const out = "CompileSwift normal arm64\n/w/A.swift:3:1: error: cannot find 'x' in scope\nnoise\n/w/A.swift:3:1: error: cannot find 'x' in scope\n** BUILD FAILED **\n";
    assert.deepEqual(summarizeBuild(out), ["/w/A.swift:3:1: error: cannot find 'x' in scope", "** BUILD FAILED **"]);
    assert.ok(compareVersions("27.0", "26.4") > 0 && compareVersions("26.10", "26.4") > 0 && compareVersions("27", "27.0") === 0);
  });
});

describe("the workstation's simulator (fake simctl and AXe, real sandbox)", () => {
  test("one device per workstation: created, booted, reused, recreated for another iOS, erased at the end", async () => {
    const f = fixture(true);
    try {
      await call(f.env, clone);
      const sim = installFakeSim(f.layout, join(f.env.root, "cache"));
      const first = await call<SimDevice>(f.env, { op: "sim.boot", scope: SCOPE });
      assert.equal(first.name, deviceName(f.env));
      assert.equal(first.name, "agentswarm-ws-1");
      assert.equal(first.runtime, "com.apple.CoreSimulator.SimRuntime.iOS-27-0", "the newest available iOS, not watchOS or an unavailable one");
      assert.equal(first.deviceType, "com.apple.CoreSimulator.SimDeviceType.iPhone-17");
      const again = await call<SimDevice>(f.env, { op: "sim.boot", scope: SCOPE });
      assert.equal(again.udid, first.udid);
      assert.equal(sim.calls().filter((c) => c[1] === "create").length, 1);
      const older = await call<SimDevice>(f.env, { op: "sim.boot", scope: SCOPE, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4" });
      assert.notEqual(older.udid, first.udid);
      assert.deepEqual(sim.devices().map((d) => d.runtime), ["com.apple.CoreSimulator.SimRuntime.iOS-26-4"]);
      await assert.rejects(call(f.env, { op: "sim.boot", scope: SCOPE, runtime: "x; rm -rf ~" }), { code: "bad_request" });
      const done = await call<{ erased: boolean }>(f.env, { op: "sim.shutdown", scope: SCOPE });
      assert.equal(done.erased, true);
      assert.equal(sim.devices()[0]!.state, "Shutdown");
      assert.equal((sim.devices()[0] as unknown as { erased: number }).erased, 1);
      // Every simctl and AXe call named this workstation's device, never the other one on the machine.
      assert.ok(!JSON.stringify(sim.calls()).includes("OTHER-0000"));
    } finally {
      f.cleanup();
    }
  });

  test("build and install, launch, read the screen, tap, type, swipe, buttons, logs", async () => {
    const f = fixture(true);
    try {
      await call(f.env, clone);
      const sim = installFakeSim(f.layout, join(f.env.root, "cache"));
      await assert.rejects(call(f.env, { op: "sim.tap", scope: SCOPE, x: 1, y: 1 }), { code: "conflict" }, "not booted yet");
      const { udid } = await call<SimDevice>(f.env, { op: "sim.boot", scope: SCOPE });
      const built = await call<SimBuildResult>(f.env, { op: "sim.build", scope: SCOPE, project: "App.xcodeproj", scheme: "Demo" });
      assert.deepEqual([built.ok, built.bundleId, built.app], [true, "com.example.demo", "Demo.app"]);
      const xb = sim.calls().find((c) => c[0] === "xcodebuild")!;
      assert.ok(xb.includes(`id=${udid}`) && xb.includes("CODE_SIGNING_ALLOWED=NO") && xb.includes(join(f.env.root, SCOPE, "App.xcodeproj")), JSON.stringify(xb));
      const broken = await call<SimBuildResult>(f.env, { op: "sim.build", scope: SCOPE, scheme: "FAIL_BUILD" });
      assert.equal(broken.ok, false);
      assert.deepEqual(broken.errors, ["/w/App/ContentView.swift:12:5: error: cannot find 'Foo' in scope", "** BUILD FAILED **"]);
      await assert.rejects(call(f.env, { op: "sim.build", scope: SCOPE, project: "../../other/App.xcodeproj", scheme: "Demo" }), { code: "out_of_scope" });
      await assert.rejects(call(f.env, { op: "sim.build", scope: SCOPE, project: "App.txt", scheme: "Demo" }), { code: "bad_request" });

      assert.deepEqual(await call(f.env, { op: "sim.launch", scope: SCOPE, bundleId: "com.example.demo", args: ["-UITestSkipLogin", "YES"] }), { pid: 4242 });
      await assert.rejects(call(f.env, { op: "sim.launch", scope: SCOPE, bundleId: "com.example.demo; reboot" }), { code: "bad_request" });
      const tree = await call<UiElement[]>(f.env, { op: "sim.ui", scope: SCOPE });
      assert.equal(tree[0]!.label, "Settings");
      assert.deepEqual(tree[0]!.frame, [0, 0, 402, 874]);
      assert.ok(!JSON.stringify(tree).includes("custom_actions"));
      await call(f.env, { op: "sim.tap", scope: SCOPE, x: 200, y: 400.25 });
      await call(f.env, { op: "sim.type", scope: SCOPE, text: "milk & eggs; $(reboot)" });
      await call(f.env, { op: "sim.swipe", scope: SCOPE, from: [200, 700], to: [200, 200] });
      await call(f.env, { op: "sim.button", scope: SCOPE, button: "home" });
      await assert.rejects(call(f.env, { op: "sim.button", scope: SCOPE, button: "power-off" }), { code: "bad_request" });
      await assert.rejects(call(f.env, { op: "sim.tap", scope: SCOPE, x: -1, y: 5 }), { code: "bad_request" });
      const axe = sim.calls().filter((c) => c[0] === "axe");
      assert.deepEqual(axe.find((c) => c[1] === "tap"), ["axe", "tap", "-x", "200", "-y", "400.3", "--tap-style", "physical", "--udid", udid]);
      assert.deepEqual(axe.find((c) => c[1] === "type"), ["axe", "type", "--stdin", "--udid", udid, "milk & eggs; $(reboot)"], "text goes in on stdin, untouched");
      const log = await call<{ output: string }>(f.env, { op: "sim.logs", scope: SCOPE, process: "Fridgy" });
      assert.match(log.output, /hello from the app/);
      await assert.rejects(call(f.env, { op: "sim.logs", scope: SCOPE, process: 'x" OR 1' }), { code: "bad_request" });
    } finally {
      f.cleanup();
    }
  });

  test("screenshots come back as model-sized JPEGs; evidence is saved inside the worktree only", async () => {
    const f = fixture(true);
    try {
      await call(f.env, clone);
      installFakeSim(f.layout, join(f.env.root, "cache"));
      await call(f.env, { op: "sim.boot", scope: SCOPE });
      const shot = await call<ImageResult>(f.env, { op: "sim.screenshot", scope: SCOPE, saveAs: "docs/agentswarm/t1/screenshots/01-home.jpg" });
      assert.deepEqual([shot.sourceWidth, shot.sourceHeight], [60, 130]);
      const jpeg = Buffer.from(shot.jpeg, "base64");
      assert.equal(jpeg[0], 0xff);
      assert.deepEqual(imageSize(jpeg), { width: shot.width, height: shot.height });
      assert.equal(shot.saved, "docs/agentswarm/t1/screenshots/01-home.jpg");
      assert.ok(existsSync(join(f.env.root, SCOPE, shot.saved)));
      // A closer look: the top-left quarter of the full capture (30×65 px), enlarged to the model's size.
      const close = await call<ImageResult>(f.env, { op: "sim.screenshot", scope: SCOPE, region: [0, 0, 500, 500] });
      assert.deepEqual(close.region, [0, 0, 500, 500]);
      assert.equal(close.height, 1000, "a small crop is scaled up");
      assert.ok(Math.abs(close.width / close.height - 30 / 65) < 0.02, `${close.width}×${close.height}`);
      for (const region of [[0, 0, 5, 5], [0, 0, 2000, 10], "all"]) {
        await assert.rejects(call(f.env, { op: "sim.screenshot", scope: SCOPE, region: region as never }), { code: "bad_request" }, String(region));
      }
      for (const bad of ["../x.jpg", ".git/x.jpg", "a.png", "/tmp/x.jpg"]) {
        await assert.rejects(call(f.env, { op: "sim.screenshot", scope: SCOPE, saveAs: bad }), (e: { code: string }) => ["bad_request", "out_of_scope"].includes(e.code), bad);
      }
    } finally {
      f.cleanup();
    }
  });
});

describe("browser address rules", () => {
  test("loopback and the public internet yes; LAN, tailnet, link-local and other schemes no", async () => {
    for (const ip of ["127.0.0.1", "::1", "8.8.8.8", "2606:4700::1111"]) assert.equal(addressAllowed(ip), true, ip);
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.10", "100.101.102.103", "169.254.169.254", "0.0.0.0", "224.0.0.1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.0.1"]) assert.equal(addressAllowed(ip), false, ip);
    const dns = async (host: string) => ({ "example.com": ["93.184.215.14"], "rebind.example": ["93.184.215.14", "192.168.1.1"], "nas.local": ["10.0.0.2"] })[host] ?? [];
    assert.equal(await urlAllowed("http://localhost:3100/", dns), true);
    assert.equal(await urlAllowed("http://127.0.0.1:5173/x", dns), true);
    assert.equal(await urlAllowed("https://example.com/", dns), true);
    assert.equal(await urlAllowed("https://rebind.example/", dns), false, "any private address refuses the name");
    assert.equal(await urlAllowed("http://nas.local/", dns), false);
    assert.equal(await urlAllowed("http://[fd7a:115c:a1e0::1]:8444/", dns), false);
    assert.equal(await urlAllowed("http://mac-mini.tail8abe68.ts.net:8444/", async () => ["100.80.1.2"]), false);
    assert.equal(await urlAllowed("file:///etc/passwd", dns), false);
    assert.equal(await urlAllowed("chrome://settings", dns), false);
    assert.equal(await urlAllowed("http://unknown.invalid/", dns), false);
    assert.equal(await urlAllowed("data:text/html,hi", dns), true);
    assert.equal(await urlAllowed("http://127.0.0.1.evil.example/", async () => ["192.168.1.1"]), false, "a name that only looks like loopback is resolved and refused");
    assert.equal(await urlAllowed("http://[::]/", dns), false);
    assert.equal(await urlAllowed("http://[64:ff9b::c0a8:101]/", dns), false, "NAT64 of a LAN address");
  });

  test("clicking and typing only on local pages and the project's test sites", () => {
    assert.equal(interactAllowed("http://localhost:3100/login", []), true);
    assert.equal(interactAllowed("http://127.0.0.1:8080/", []), true);
    assert.equal(interactAllowed("https://example.com/form", []), false);
    assert.equal(interactAllowed("https://staging.example.com/a", ["https://staging.example.com"]), true);
    assert.equal(interactAllowed("https://staging.example.com.evil.io/", ["https://staging.example.com"]), false);
  });
});

/** The pinned browser: installed by setup.sh, or AGENTSWARM_TEST_BROWSER_TOOLS (a dir with playwright-core/ and chromium/). */
function browserTools(): string | null {
  const dir = process.env.AGENTSWARM_TEST_BROWSER_TOOLS ?? PRODUCTION_LAYOUT.toolsDir;
  return existsSync(join(dir, "playwright-core", "index.mjs")) && existsSync(join(dir, "chromium")) ? dir : null;
}

async function serve(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/away") {
      res.writeHead(302, { location: "http://192.168.1.1/admin" });
      return res.end();
    }
    res.end(req.url === "/next"
      ? "<title>Next</title><h1>Second page</h1>"
      : `<title>Demo</title><h1 id="h">Hello</h1><label>Name <input id="n"></label><button onclick="document.getElementById('h').textContent='Hi '+document.getElementById('n').value">Greet</button><a href="/next">Next</a>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

/** Drives a browser.session through dispatch: commands in as lines, replies out as events. */
function session(env: ExecEnv, interact: string[] = []) {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const input: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const waiting = new Map<number, (v: any) => void>();
  let ready: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const done = dispatch(env, { op: "browser.session", scope: SCOPE, interact, timeoutMs: 120_000 }, (e: any) => {
    if (e.ready) ready();
    if (typeof e.id === "number") waiting.get(e.id)?.(e);
  }, input);
  let next = 1;
  return {
    isReady,
    done,
    send(cmd: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
      const id = next++;
      const p = new Promise<any>((r) => waiting.set(id, r));
      queue.push(JSON.stringify({ id, ...cmd }));
      wake?.();
      return p;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

describe("the browser (real headless Chromium, real sandbox)", { skip: browserTools() ? false : "no pinned browser installed (setup.sh --update-exec, or AGENTSWARM_TEST_BROWSER_TOOLS)" }, () => {
  test("open, read the page with refs, type, click, screenshot; LAN and denied ports refused; no debugging port", { timeout: 120_000 }, async () => {
    const f = fixture(true);
    const { server, port } = await serve();
    const denied = await serve();
    try {
      const tools = browserTools()!;
      mkdirSync(f.layout.toolsDir, { recursive: true });
      for (const d of ["playwright-core", "chromium"]) symlinkSync(join(tools, d), join(f.layout.toolsDir, d));
      copyFileSync(join(import.meta.dirname, "..", "src", "ops", "browser-driver.ts"), join(f.layout.toolsDir, "browser-driver.ts"));
      mkdirSync(join(f.layout.mirrors, ".agentswarm"), { recursive: true });
      writeFileSync(denyPortsFile(f.env), JSON.stringify([denied.port]));
      await call(f.env, clone);
      const s = session(f.env);
      await s.isReady;
      const opened = await s.send({ cmd: "open", url: `http://127.0.0.1:${port}/` });
      assert.equal(opened.ok, true, opened.error);
      assert.equal(opened.result.title, "Demo");
      const snap = await s.send({ cmd: "snapshot" });
      const ref = (name: RegExp) => (snap.result.snapshot as string).split("\n").find((l) => name.test(l))?.match(/\[ref=([A-Za-z0-9]+)\]/)?.[1];
      assert.ok(ref(/textbox/) && ref(/button "Greet"/), snap.result.snapshot);
      assert.equal((await s.send({ cmd: "fill", ref: ref(/textbox/), text: "Zac" })).ok, true);
      assert.equal((await s.send({ cmd: "click", ref: ref(/button "Greet"/) })).ok, true);
      assert.match((await s.send({ cmd: "snapshot" })).result.snapshot, /Hi Zac/);
      const shot = await s.send({ cmd: "screenshot", saveAs: "docs/agentswarm/t1/screenshots/greet.jpg" });
      assert.equal(shot.ok, true, shot.error);
      assert.ok(shot.result.width <= 1000 && shot.result.jpeg.length > 1000 && !("png" in shot.result));
      assert.ok(existsSync(join(f.env.root, SCOPE, "docs/agentswarm/t1/screenshots/greet.jpg")));
      assert.equal((await s.send({ cmd: "screenshot", saveAs: "../../escape.jpg" })).ok, false);
      const lan = await s.send({ cmd: "open", url: "http://192.168.1.1/" });
      assert.equal(lan.ok, false);
      assert.match(lan.error!, /not allowed/);
      const away = await s.send({ cmd: "open", url: `http://127.0.0.1:${port}/away` });
      assert.equal(away.ok, false, "a redirect into the LAN is refused too");
      const blocked = await s.send({ cmd: "open", url: `http://127.0.0.1:${denied.port}/` });
      assert.equal(blocked.ok, false, "seatbelt refuses the denied port for the browser too");
      const bogus = await s.send({ cmd: "launch_missiles" });
      assert.equal(bogus.ok, false);
      // ps cannot run inside the sandbox; look from outside. Playwright drives Chromium over a pipe.
      const chrome = execFileSync("/bin/ps", ["-axo", "args="]).toString().split("\n").filter((l) => l.includes(join(f.layout.toolsDir, "chromium")) || l.includes("chrome-headless-shell") && l.includes(f.env.root));
      assert.ok(chrome.length > 0, "the session's Chromium is running");
      assert.ok(chrome.every((l) => !l.includes("--remote-debugging-port")) && chrome.some((l) => l.includes("--remote-debugging-pipe")), chrome.join("\n"));
      s.close();
      const res = await s.done;
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal((res as { result: { closed: string } }).result.closed, "closed");
      assert.deepEqual(readdirSync(join(f.env.root, ".tmp", SCOPE.replaceAll("/", "__"))).filter((n) => n.startsWith("browser-profile")), [], "the profile is removed");
    } finally {
      server.close();
      denied.server.close();
      f.cleanup();
    }
  });

  test("on other sites the agent can only read", { timeout: 60_000 }, async () => {
    const f = fixture(true);
    try {
      const tools = browserTools()!;
      mkdirSync(f.layout.toolsDir, { recursive: true });
      for (const d of ["playwright-core", "chromium"]) symlinkSync(join(tools, d), join(f.layout.toolsDir, d));
      copyFileSync(join(import.meta.dirname, "..", "src", "ops", "browser-driver.ts"), join(f.layout.toolsDir, "browser-driver.ts"));
      await call(f.env, clone);
      await assert.rejects(call(f.env, { op: "browser.session", scope: SCOPE, interact: ["https://ok.example/path"], timeoutMs: 60_000 }), { code: "bad_request" });
      const s = session(f.env);
      await s.isReady;
      await s.send({ cmd: "open", url: "data:text/html,<button>x</button>" });
      const ref = ((await s.send({ cmd: "snapshot" })).result.snapshot as string).match(/button "x" \[ref=([A-Za-z0-9]+)\]/)?.[1];
      const clicked = await s.send({ cmd: "click", ref });
      assert.equal(clicked.ok, true, `a local data page may be clicked: ${clicked.error}`);
      assert.equal((await s.send({ cmd: "click", ref: "e1; alert(1)" })).ok, false);
      s.close();
      await s.done;
    } finally {
      f.cleanup();
    }
  });
});
