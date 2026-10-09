import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A bun binary, the daemon bundle and playwright-core under the system temp dir (outside /Volumes,
 * which the sandbox denies), built once per daemon source version and shared by test runs.
 */
export async function browserRuntime(): Promise<{ binDir: string; browserDir: string }> {
  const source = await Bun.file(join(import.meta.dir, "../src/browser/daemon.ts")).text() + await Bun.file(join(import.meta.dir, "../src/browser/url-guard.ts")).text();
  const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 12);
  const base = join(realpathSync(tmpdir()), `hive-browser-runtime-${hash}`);
  const binDir = join(base, "bin");
  const browserDir = join(base, "browser");
  if (!existsSync(join(browserDir, "daemon.js"))) {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(browserDir, "node_modules"), { recursive: true });
    cpSync(process.execPath, join(binDir, "bun"));
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/browser/daemon.ts")], target: "bun", external: ["playwright-core"] });
    if (!built.success) throw new Error(built.logs.join("\n"));
    await Bun.write(join(browserDir, "daemon.js"), built.outputs[0]!);
    cpSync(realpathSync(join(import.meta.dir, "../node_modules/playwright-core")), join(browserDir, "node_modules/playwright-core"), { recursive: true });
  }
  return { binDir, browserDir };
}
