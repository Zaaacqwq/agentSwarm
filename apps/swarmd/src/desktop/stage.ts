import { execFile } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The system's own tools (stdout back); tests swap codesign for a fake. */
export interface StageTools {
  tar(args: string[]): Promise<string>;
  plutil(args: string[]): Promise<string>;
  codesign(args: string[]): Promise<string>;
}

const tool = (path: string, timeout: number) => async (args: string[]) => (await run(path, args, { timeout, maxBuffer: 32 * 1024 * 1024 })).stdout;

export const SYSTEM_TOOLS: StageTools = {
  tar: tool("/usr/bin/tar", 120_000),
  plutil: tool("/usr/bin/plutil", 30_000),
  codesign: tool("/usr/bin/codesign", 300_000),
};

/** What an app under test may unpack to. */
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;

/** The id every app under test of a project runs as: never the id the agent chose (it could name a real app). */
export const testBundleId = (projectSlug: string) => `dev.agentswarm.test.${projectSlug.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 60)}`;

/**
 * Parts of a bundle the system would start on its own, outside the app and its sandbox's reach: helper apps,
 * login items, launch agents, XPC services, extensions. A test build does not need them; they are removed.
 */
export const STRIPPED_PARTS = ["Contents/Library", "Contents/XPCServices", "Contents/PlugIns", "Contents/Extensions", "Contents/Helpers", "Contents/LoginItems"];

/** Info.plist keys that register the app with the system (URL schemes, documents, services) or change how it starts. */
export const STRIPPED_KEYS = [
  "LSEnvironment", "CFBundleURLTypes", "CFBundleDocumentTypes", "NSServices", "UTExportedTypeDeclarations", "UTImportedTypeDeclarations",
  "NSAppleScriptEnabled", "OSAScriptingDefinition", "SMPrivilegedExecutables", "SMAuthorizedClients", "LSBackgroundOnly", "LSMultipleInstancesProhibited",
];

/** App Sandbox: its own container, no access to your files, network only when the project allows it. */
export function entitlements(network: boolean): string {
  const keys = [["com.apple.security.app-sandbox", true], ["com.apple.security.network.client", network]] as const;
  const body = keys.filter(([, v]) => v).map(([k]) => `  <key>${k}</key><true/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/**
 * Checks a `tar -tvz` listing before anything is unpacked: only files, folders and links, all inside the one
 * app, no `..`, and a bounded size. The system's tar also refuses to write through links or outside the folder.
 */
export function checkListing(listing: string, app: string): void {
  const lines = listing.split("\n").filter((l) => l.trim());
  if (lines.length > MAX_ENTRIES) throw new Error(`The app has more than ${MAX_ENTRIES} files`);
  let bytes = 0;
  for (const line of lines) {
    const m = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/.exec(line);
    if (!m) throw new Error(`Unreadable entry in the app: ${line.slice(0, 120)}`);
    const [, type, size, rest] = m;
    if (type !== "-" && type !== "d" && type !== "l") throw new Error(`The app holds something that is not a file, folder or link: ${rest!.slice(0, 120)}`);
    const name = type === "l" ? rest!.split(" -> ")[0]! : rest!;
    if (name !== app && name !== `${app}/` && !name.startsWith(`${app}/`)) throw new Error(`The archive holds more than the app: ${name.slice(0, 120)}`);
    if (name.split("/").includes("..")) throw new Error(`The app has a path with "..": ${name.slice(0, 120)}`);
    bytes += Number(size);
    if (bytes > MAX_UNPACKED_BYTES) throw new Error("The app is too large to open");
  }
}

/** Links must stay inside the bundle once fully resolved; a link that resolves to nothing is refused too. */
export function linksOutside(root: string): string[] {
  const base = realpathSync(root);
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        let target: string | null;
        try {
          target = realpathSync(path);
        } catch {
          target = null;
        }
        if (!target || (target !== base && !target.startsWith(base + sep))) bad.push(path.slice(base.length + 1));
      } else if (st.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(base);
  return bad;
}

/** Mach-O, thin or universal: a script as the main program would run outside the sandbox (its interpreter has none). */
export function isMachO(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    const magic = head.readUInt32BE(0);
    return [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xcafebabf].includes(magic);
  } finally {
    closeSync(fd);
  }
}

/** Nested apps, XPC services or extensions left after stripping: they would start without this app's sandbox. */
function nestedBundles(app: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!lstatSync(path).isDirectory()) continue;
      if (/\.(app|xpc|appex|systemextension|kext)$/i.test(name)) found.push(`${rel}${name}`);
      else walk(path, `${rel}${name}/`);
    }
  };
  walk(join(app, "Contents"), "Contents/");
  return found;
}

/**
 * Unpacks the app a workstation built into `dir` (a fresh folder under the helper's apps directory), checks and
 * trims it, renames it, and signs it for the App Sandbox, dropping whatever signature and entitlements it came
 * with. Returns its path.
 */
export async function stageApp(input: { archive: Buffer; dir: string; app: string; projectSlug: string; network: boolean; tools?: StageTools }): Promise<string> {
  const tools = input.tools ?? SYSTEM_TOOLS;
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,150}\.app$/.test(input.app)) throw new Error("The build named an odd app");
  // The archive and the entitlements live apart from what is unpacked: nothing in it can point at them.
  const work = mkdtempSync(join(tmpdir(), "agentswarm-stage-"));
  try {
    const archive = join(work, "app.tgz");
    writeFileSync(archive, input.archive, { mode: 0o600, flag: "wx" });
    checkListing(await tools.tar(["-tvzf", archive]), input.app);
    rmSync(input.dir, { recursive: true, force: true });
    // Readable by the workstation user who runs it, writable only by swarmd.
    mkdirSync(input.dir, { recursive: true, mode: 0o755 });
    await tools.tar(["-xzf", archive, "-C", input.dir, "--no-same-owner", "--no-same-permissions"]);
    const app = join(input.dir, input.app);
    const st = lstatSync(app);
    if (!st.isDirectory() || !realpathSync(app).startsWith(realpathSync(input.dir) + sep)) throw new Error("The app is not a folder inside the staging area");
    const outside = linksOutside(app);
    if (outside.length) throw new Error(`The app has links that point outside it: ${outside.slice(0, 3).join(", ")}`);
    for (const part of STRIPPED_PARTS) rmSync(join(app, part), { recursive: true, force: true });
    const nested = nestedBundles(app);
    if (nested.length) throw new Error(`The app contains other apps or extensions, which would run outside its sandbox: ${nested.slice(0, 3).join(", ")}`);
    const plist = join(app, "Contents", "Info.plist");
    const exe = (await tools.plutil(["-extract", "CFBundleExecutable", "raw", "-o", "-", plist])).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,150}$/.test(exe)) throw new Error("The app's main program has an odd name");
    const exePath = join(app, "Contents", "MacOS", exe);
    if (!lstatSync(exePath).isFile() || !isMachO(exePath)) throw new Error("The app's main program is not a compiled program (a script would run outside the sandbox)");
    for (const key of STRIPPED_KEYS) await tools.plutil(["-remove", key, plist]).catch(() => undefined);
    await tools.plutil(["-replace", "CFBundleIdentifier", "-string", testBundleId(input.projectSlug), plist]);
    const ent = join(work, "sandbox.entitlements");
    writeFileSync(ent, entitlements(input.network), { mode: 0o600, flag: "wx" });
    await tools.codesign(["--force", "--deep", "--sign", "-", "--entitlements", ent, app]);
    const signed = await tools.codesign(["-d", "--entitlements", ":-", app]);
    if (!signed.includes("com.apple.security.app-sandbox")) throw new Error("Signing for the App Sandbox did not take");
    return app;
  } catch (error) {
    rmSync(input.dir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
