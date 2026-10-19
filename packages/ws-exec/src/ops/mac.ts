import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError, type MacBuildResult } from "../protocol.ts";
import { readProduced, resolveInScope } from "../paths.ts";
import { space } from "../space.ts";
import { ctx, MAX_BUILD_MS, newestApp, ok, run, summarizeBuild } from "./sim.ts";

/** The packed app swarmd takes back to open on the desktop (R9): a debug build of a small app is a few MB. */
export const MAX_APP_BYTES = 100 * 1024 * 1024;

/**
 * R9: builds the macOS app in this workstation's sandbox (unsigned: swarmd signs it for the App Sandbox) and
 * packs it with ditto, so swarmd can open it in your session during an approved desktop session.
 */
export async function build(env: ExecEnv, scope: string, r: { project?: string; workspace?: string; scheme: string; configuration?: string; timeoutMs?: number }): Promise<MacBuildResult> {
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
  const home = space(env, scope).home;
  const derived = join(home, "DerivedData-mac");
  const timeoutMs = Math.min(Math.max(60_000, r.timeoutMs ?? 900_000), MAX_BUILD_MS);
  const started = Date.now();
  const failed = (errors: string[]): MacBuildResult => ({ ok: false, errors, durationMs: Date.now() - started, app: null, bundleId: null, archive: null });
  const out = await run(c, [join(env.layout.toolsDir, "bin", "xcodebuild"), ...container, "-scheme", r.scheme, "-configuration", configuration,
    "-destination", "platform=macOS", "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO", "build"], { timeoutMs });
  const errors = summarizeBuild(out.output);
  if (out.exitCode !== 0) return failed(errors);
  const app = newestApp(join(derived, "Build", "Products", configuration));
  if (!app) return failed(["The build succeeded but produced no .app (is the scheme a macOS app?)"]);
  const bundleId = (await ok(c, ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")])).trim();
  const zip = join(home, "mac-app.zip");
  rmSync(zip, { force: true });
  await ok(c, ["/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip], { timeoutMs: 120_000 });
  if (!existsSync(zip)) return failed(["Packing the app failed"]);
  const archive = readProduced(zip, MAX_APP_BYTES);
  rmSync(zip, { force: true });
  return { ok: true, errors, durationMs: Date.now() - started, app: basename(app), bundleId, archive: archive.toString("base64") };
}
