import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError, type ExecResult, type ImageResult, type SimBuildResult, type SimDevice, type UiElement } from "../protocol.ts";
import { resolveInScope, resolveScope } from "../paths.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";
import { space } from "../space.ts";
import { checkRegion, toModelImage } from "./image.ts";

/**
 * This workstation's own simulator (R6). Each workstation user has its own CoreSimulator device set (R0), and
 * every op works on the one device named after the user: a request can never pick another device.
 */
export const deviceName = (env: ExecEnv) => `agentswarm-${env.user}`;
export const DEFAULT_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

const IDENT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,150}$/;
const PROCESS_NAME = /^[A-Za-z0-9 ._-]{1,80}$/;
export const SIM_BUTTONS = ["home", "lock", "side-button", "siri", "apple-pay"] as const;
const MAX_BUILD_MS = 1_800_000;

interface Ctx {
  readonly env: ExecEnv;
  readonly scope: string;
  readonly cwd: string;
}

function ctx(env: ExecEnv, scope: string): Ctx {
  return { env, scope, cwd: resolveScope(env.root, scope) };
}

async function run(c: Ctx, argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<ExecResult> {
  const r = await runProcess(c.env, sandboxed(c.env, argv, c.scope), { cwd: c.cwd, scope: c.scope, timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
  if (r.timedOut) throw new OpError("timeout", `${basename(argv[0]!)} ${argv[1] ?? ""} timed out`);
  return r;
}

async function ok(c: Ctx, argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<string> {
  const r = await run(c, argv, opts);
  if (r.exitCode !== 0) throw new OpError("failed", r.output.trim().slice(-800) || `${basename(argv[0]!)} exited with ${r.exitCode}`);
  return r.output;
}

const simctl = (c: Ctx, args: string[], timeoutMs?: number) => ok(c, [c.env.layout.xcrun, "simctl", ...args], timeoutMs ? { timeoutMs } : {});
const axePath = (env: ExecEnv) => join(env.layout.toolsDir, "axe", "axe");

interface SimctlDevice { udid: string; name: string; state: string; deviceTypeIdentifier?: string }

async function listDevices(c: Ctx): Promise<{ runtime: string; device: SimctlDevice }[]> {
  const data = JSON.parse(await jsonOut(c, [c.env.layout.xcrun, "simctl", "list", "devices", "-j"])) as { devices: Record<string, SimctlDevice[]> };
  return Object.entries(data.devices).flatMap(([runtime, list]) => list.map((device) => ({ runtime, device })));
}

/** The newest available iOS runtime. */
async function latestRuntime(c: Ctx): Promise<string> {
  const data = JSON.parse(await jsonOut(c, [c.env.layout.xcrun, "simctl", "list", "runtimes", "-j"])) as { runtimes: { identifier: string; version: string; isAvailable: boolean; platform?: string }[] };
  const ios = data.runtimes.filter((r) => r.isAvailable && (r.platform === "iOS" || r.identifier.includes(".iOS-")));
  ios.sort((a, b) => compareVersions(b.version, a.version));
  if (!ios[0]) throw new OpError("failed", "No iOS simulator runtime is installed (Xcode → Settings → Components)");
  return ios[0].identifier;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Runs argv with stdout in a file and returns its text: output in memory keeps only a 64 KB tail. */
async function jsonOut(c: Ctx, argv: string[], timeoutMs = 60_000): Promise<string> {
  const dir = space(c.env, c.scope).tmp;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `out-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  // The command goes in as positional parameters, never into the script text.
  const r = await run(c, ["/bin/zsh", "-c", 'out="$1"; shift; "$@" > "$out"', "zsh", file, ...argv], { timeoutMs });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  rmSync(file, { force: true });
  if (r.exitCode !== 0) throw new OpError("failed", (r.output.trim() || text.trim()).slice(-800) || `exit ${r.exitCode}`);
  return text;
}

async function findDevice(c: Ctx): Promise<{ runtime: string; device: SimctlDevice } | undefined> {
  return (await listDevices(c)).find((d) => d.device.name === deviceName(c.env));
}

async function requireBooted(c: Ctx): Promise<SimctlDevice> {
  const found = await findDevice(c);
  if (!found || found.device.state !== "Booted") throw new OpError("conflict", "The simulator is not running; boot it first (sim.boot)");
  return found.device;
}

/** Creates this workstation's device if needed (or again, if asked for another model or iOS), and boots it. */
export async function boot(env: ExecEnv, scope: string, deviceType?: string, runtime?: string): Promise<SimDevice> {
  const c = ctx(env, scope);
  for (const id of [deviceType, runtime]) if (id !== undefined && !IDENT.test(id)) throw new OpError("bad_request", `Invalid simulator identifier: ${id}`);
  const wantType = deviceType ?? DEFAULT_DEVICE_TYPE;
  const wantRuntime = runtime ?? (await latestRuntime(c));
  const started = Date.now();
  let found = await findDevice(c);
  if (found && (found.runtime !== wantRuntime || (found.device.deviceTypeIdentifier && found.device.deviceTypeIdentifier !== wantType))) {
    await run(c, [env.layout.xcrun, "simctl", "shutdown", found.device.udid]);
    await simctl(c, ["delete", found.device.udid]);
    found = undefined;
  }
  const udid = found?.device.udid ?? (await simctl(c, ["create", deviceName(env), wantType, wantRuntime])).trim().split("\n").pop()!.trim();
  if (found?.device.state !== "Booted") {
    const r = await run(c, [env.layout.xcrun, "simctl", "boot", udid], { timeoutMs: 120_000 });
    if (r.exitCode !== 0 && !/current state: Booted/.test(r.output)) throw new OpError("failed", r.output.trim().slice(-800));
    await simctl(c, ["bootstatus", udid, "-b"], 240_000);
  }
  return { udid, name: deviceName(env), deviceType: wantType, runtime: wantRuntime, bootMs: Date.now() - started };
}

/** Builds for this workstation's simulator (through the xcodebuild wrapper), installs the app, returns its bundle id. */
export async function build(env: ExecEnv, scope: string, r: { project?: string; workspace?: string; scheme: string; configuration?: string; timeoutMs?: number }): Promise<SimBuildResult> {
  const c = ctx(env, scope);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,100}$/.test(r.scheme)) throw new OpError("bad_request", "Invalid scheme");
  const configuration = r.configuration ?? "Debug";
  if (!/^[A-Za-z0-9 _-]{1,40}$/.test(configuration)) throw new OpError("bad_request", "Invalid configuration");
  const container: string[] = [];
  for (const [flag, path, ext] of [["-workspace", r.workspace, ".xcworkspace"], ["-project", r.project, ".xcodeproj"]] as const) {
    if (path === undefined) continue;
    if (!path.endsWith(ext)) throw new OpError("bad_request", `${flag} must name a ${ext}`);
    container.push(flag, resolveInScope(c.cwd, path));
  }
  const device = await requireBooted(c);
  const derived = join(space(env, scope).home, "DerivedData");
  const timeoutMs = Math.min(Math.max(60_000, r.timeoutMs ?? 900_000), MAX_BUILD_MS);
  const started = Date.now();
  const out = await run(c, [join(env.layout.toolsDir, "bin", "xcodebuild"), ...container, "-scheme", r.scheme, "-configuration", configuration,
    "-destination", `id=${device.udid}`, "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO", "build"], { timeoutMs });
  const errors = summarizeBuild(out.output);
  if (out.exitCode !== 0) return { ok: false, errors, durationMs: Date.now() - started, bundleId: null, app: null };
  const app = newestApp(join(derived, "Build", "Products", `${configuration}-iphonesimulator`));
  if (!app) return { ok: false, errors: ["The build succeeded but produced no .app"], durationMs: Date.now() - started, bundleId: null, app: null };
  await simctl(c, ["install", device.udid, app], 180_000);
  const bundleId = (await ok(c, ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")])).trim();
  return { ok: true, errors, durationMs: Date.now() - started, bundleId, app: basename(app) };
}

/** The lines that say what went wrong, without the noise around them. */
export function summarizeBuild(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim());
  const errors = lines.filter((l) => /(^|\s)error: /.test(l) || /^\*\* BUILD FAILED \*\*/.test(l) || /^xcodebuild: error/.test(l));
  return [...new Set(errors)].slice(0, 40).map((l) => l.slice(0, 400));
}

function newestApp(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const apps = readdirSync(dir).filter((f) => f.endsWith(".app")).map((f) => join(dir, f));
  apps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return apps[0] ?? null;
}

export async function launch(env: ExecEnv, scope: string, bundleId: string, args: readonly string[] = []): Promise<{ pid: number | null }> {
  const c = ctx(env, scope);
  if (!IDENT.test(bundleId)) throw new OpError("bad_request", "Invalid bundle id");
  if (args.length > 20 || args.some((a) => a.length > 300 || a.includes("\0"))) throw new OpError("bad_request", "Too many or too long launch arguments");
  const device = await requireBooted(c);
  const out = await simctl(c, ["launch", "--terminate-running-process", device.udid, bundleId, ...args], 60_000);
  const pid = Number(out.trim().split(":").pop());
  return { pid: Number.isFinite(pid) ? pid : null };
}

/** The accessibility tree. AXe's first call after a boot often times out creating its session (R0): retry. */
export async function ui(env: ExecEnv, scope: string): Promise<UiElement[]> {
  const c = ctx(env, scope);
  const device = await requireBooted(c);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return trimTree(JSON.parse(await jsonOut(c, [axePath(env), "describe-ui", "--udid", device.udid], 60_000)) as unknown[]);
    } catch (error) {
      last = error;
      if (!/Timed out creating/.test(String((error as Error).message))) break;
    }
  }
  throw last instanceof OpError ? last : new OpError("failed", String((last as Error)?.message ?? last));
}

/** Only what an agent needs from each element. */
export function trimTree(nodes: readonly unknown[]): UiElement[] {
  const trim = (n: Record<string, any>): UiElement => {
    const f = n.frame ?? {};
    return {
      type: String(n.type ?? n.role_description ?? ""),
      ...(n.AXLabel ? { label: String(n.AXLabel).slice(0, 300) } : {}),
      ...(n.AXValue !== null && n.AXValue !== undefined && n.AXValue !== "" ? { value: String(n.AXValue).slice(0, 300) } : {}),
      ...(n.AXUniqueId ? { id: String(n.AXUniqueId).slice(0, 200) } : {}),
      ...(n.enabled === false ? { enabled: false } : {}),
      frame: [Number(f.x) || 0, Number(f.y) || 0, Number(f.width) || 0, Number(f.height) || 0],
      ...(Array.isArray(n.children) && n.children.length ? { children: n.children.map(trim) } : {}),
    };
  };
  return nodes.map((n) => trim(n as Record<string, any>));
}

const point = (n: number) => {
  if (!Number.isFinite(n) || n < 0 || n > 5000) throw new OpError("bad_request", "Coordinates must be screen points");
  return String(Math.round(n * 10) / 10);
};

/** A physical tap (touch down, up): AXe's default tap does nothing with Xcode 27 (R0). */
export async function tap(env: ExecEnv, scope: string, x: number, y: number): Promise<{ tapped: [number, number] }> {
  const c = ctx(env, scope);
  const device = await requireBooted(c);
  await ok(c, [axePath(env), "tap", "-x", point(x), "-y", point(y), "--tap-style", "physical", "--udid", device.udid]);
  return { tapped: [x, y] };
}

export async function typeText(env: ExecEnv, scope: string, text: string): Promise<{ typed: number }> {
  const c = ctx(env, scope);
  if (!text || text.length > 2000) throw new OpError("bad_request", "Text must be 1–2000 characters");
  const device = await requireBooted(c);
  await ok(c, [axePath(env), "type", "--stdin", "--udid", device.udid], { stdin: text, timeoutMs: 120_000 });
  return { typed: text.length };
}

export async function swipe(env: ExecEnv, scope: string, from: readonly [number, number], to: readonly [number, number], durationS = 0.4): Promise<{ swiped: true }> {
  const c = ctx(env, scope);
  if (!(durationS > 0 && durationS <= 5)) throw new OpError("bad_request", "Duration must be 0–5 s");
  const device = await requireBooted(c);
  await ok(c, [axePath(env), "swipe", "--start-x", point(from[0]), "--start-y", point(from[1]), "--end-x", point(to[0]), "--end-y", point(to[1]), "--duration", String(durationS), "--udid", device.udid]);
  return { swiped: true };
}

export async function button(env: ExecEnv, scope: string, name: string): Promise<{ pressed: string }> {
  const c = ctx(env, scope);
  if (!(SIM_BUTTONS as readonly string[]).includes(name)) throw new OpError("bad_request", `Button must be one of ${SIM_BUTTONS.join(", ")}`);
  const device = await requireBooted(c);
  await ok(c, [axePath(env), "button", name, "--udid", device.udid]);
  return { pressed: name };
}

/**
 * A screenshot through AXe: simctl's own fails inside the sandbox (R6 measurement). `saveAs` keeps a JPEG in the
 * worktree as evidence (relative path, .jpg).
 */
export async function screenshot(env: ExecEnv, scope: string, saveAs?: string, region?: unknown): Promise<ImageResult> {
  const c = ctx(env, scope);
  const crop = region === undefined ? undefined : checkRegion(region);
  const save = saveAs === undefined ? undefined : evidencePath(c.cwd, saveAs);
  const device = await requireBooted(c);
  const dir = space(env, scope).tmp;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const png = join(dir, `shot-${process.pid}-${Date.now()}.png`);
  await ok(c, [axePath(env), "screenshot", "--udid", device.udid, "--output", png], { timeoutMs: 60_000 });
  return toModelImage(env, scope, c.cwd, png, save, crop);
}

/** Where evidence goes: a .jpg inside the worktree, outside .git, directories created. */
export function evidencePath(cwd: string, path: string): { path: string; abs: string } {
  if (!/\.jpe?g$/i.test(path)) throw new OpError("bad_request", "Save screenshots as .jpg");
  if (path.split("/").some((p) => p.toLowerCase() === ".git")) throw new OpError("out_of_scope", "Not inside .git");
  const abs = resolveInScope(cwd, path);
  mkdirSync(dirname(abs), { recursive: true });
  return { path, abs };
}

/** The app's recent log lines, e.g. after a crash. */
export async function logs(env: ExecEnv, scope: string, processName?: string, seconds = 120): Promise<{ output: string; truncated: boolean }> {
  const c = ctx(env, scope);
  if (processName !== undefined && !PROCESS_NAME.test(processName)) throw new OpError("bad_request", "Invalid process name");
  const last = Math.min(Math.max(5, Math.round(seconds)), 1800);
  const device = await requireBooted(c);
  const r = await run(c, [env.layout.xcrun, "simctl", "spawn", device.udid, "log", "show", "--last", `${last}s`, "--style", "compact",
    ...(processName ? ["--predicate", `process == "${processName}"`] : [])], { timeoutMs: 120_000 });
  return { output: r.output, truncated: r.truncated };
}

/** End of a run: shut down and erase, so the next project gets a clean device. */
export async function shutdown(env: ExecEnv, scope: string): Promise<{ erased: boolean }> {
  const c = ctx(env, scope);
  const found = await findDevice(c);
  if (!found) return { erased: false };
  await run(c, [env.layout.xcrun, "simctl", "shutdown", found.device.udid], { timeoutMs: 120_000 });
  await simctl(c, ["erase", found.device.udid], 180_000);
  return { erased: true };
}
