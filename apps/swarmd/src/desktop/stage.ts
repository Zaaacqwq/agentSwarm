import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Signs and unpacks with the system's own tools; tests swap them for fakes. */
export interface StageTools {
  ditto(args: string[]): Promise<void>;
  plutil(args: string[]): Promise<void>;
  codesign(args: string[]): Promise<void>;
}

export const SYSTEM_TOOLS: StageTools = {
  ditto: async (args) => void (await run("/usr/bin/ditto", args, { timeout: 120_000 })),
  plutil: async (args) => void (await run("/usr/bin/plutil", args, { timeout: 30_000 })),
  codesign: async (args) => void (await run("/usr/bin/codesign", args, { timeout: 300_000 })),
};

/** The id every app under test of a project runs as: never the id the agent chose (it could name a real app). */
export const testBundleId = (projectSlug: string) => `dev.agentswarm.test.${projectSlug.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 60)}`;

/** App Sandbox: its own container, no access to your files, network only when the project allows it. */
export function entitlements(network: boolean): string {
  const keys = [["com.apple.security.app-sandbox", true], ["com.apple.security.network.client", network]] as const;
  const body = keys.filter(([, v]) => v).map(([k]) => `  <key>${k}</key><true/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/** A link inside the bundle that points out of it would let the app (or codesign) reach other files. */
export function linksOutside(root: string): string[] {
  const base = realpathSync(root);
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path));
        if (target !== base && !target.startsWith(base + sep)) bad.push(path.slice(base.length + 1));
      } else if (st.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(base);
  return bad;
}

/**
 * Unpacks the app a workstation built into `dir` (a fresh folder under the helper's apps directory), renames
 * it, and signs it for the App Sandbox, dropping whatever signature and entitlements it came with. --deep signs
 * nested code (helpers, XPC services) the same way, so none of it runs outside the sandbox.
 */
export async function stageApp(input: { archive: Buffer; dir: string; app: string; projectSlug: string; network: boolean; tools?: StageTools }): Promise<string> {
  const tools = input.tools ?? SYSTEM_TOOLS;
  if (!/^[^/\\]{1,200}\.app$/.test(input.app)) throw new Error("The build named an odd app");
  rmSync(input.dir, { recursive: true, force: true });
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const zip = join(input.dir, "app.zip");
  writeFileSync(zip, input.archive, { mode: 0o600 });
  await tools.ditto(["-x", "-k", zip, input.dir]);
  rmSync(zip, { force: true });
  const app = join(input.dir, input.app);
  const outside = linksOutside(app);
  if (outside.length) throw new Error(`The app has links that point outside it: ${outside.slice(0, 3).join(", ")}`);
  await tools.plutil(["-replace", "CFBundleIdentifier", "-string", testBundleId(input.projectSlug), join(app, "Contents", "Info.plist")]);
  const ent = join(input.dir, "sandbox.entitlements");
  writeFileSync(ent, entitlements(input.network), { mode: 0o600 });
  await tools.codesign(["--force", "--deep", "--sign", "-", "--entitlements", ent, app]);
  return app;
}
