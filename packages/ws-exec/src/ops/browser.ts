import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { resolveScope } from "../paths.ts";
import { spawnInteractive, stopInteractive } from "../process.ts";
import { sandboxed } from "../sandbox.ts";
import { prepareSpace } from "../space.ts";
import type { DriverCommand, DriverConfig } from "./browser-driver.ts";
import { checkRegion, toModelImage, type Region } from "./image.ts";
import { evidencePath } from "./sim.ts";

export type Emit = (event: unknown) => void;

const MAX_SESSION_MS = 2 * 3600_000;
const IDLE_MS = 20 * 60_000;
const COMMANDS = new Set(["open", "snapshot", "click", "fill", "press", "back", "screenshot", "console"]);

export const browserPaths = (env: ExecEnv) => ({
  playwright: join(env.layout.toolsDir, "playwright-core"),
  chromium: join(env.layout.toolsDir, "chromium", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
});
/** Installed next to the tools (root-owned): never run from a directory the agent can write. */
export const driverPath = (env: ExecEnv) => join(env.layout.toolsDir, "browser-driver.ts");

/** Origins the project lists for clicking and typing: exactly scheme://host[:port], http or https. */
export function checkOrigins(origins: readonly string[]): string[] {
  if (origins.length > 20) throw new OpError("bad_request", "At most 20 test sites");
  return origins.map((o) => {
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new OpError("bad_request", `Not an origin: ${o}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== o) throw new OpError("bad_request", `Not an origin (scheme://host[:port]): ${o}`);
    return o;
  });
}

/**
 * One headless Chromium for a run, inside the sandbox. swarmd writes commands as lines after the request
 * ({id, cmd, …}); each reply comes back as an event. Screenshots are turned into model images here, and
 * evidence paths are checked here, so the driver never decides where files go. Ends when swarmd closes stdin.
 */
export async function session(env: ExecEnv, scope: string, interact: readonly string[], timeoutMs: number, input: AsyncIterable<string>, emit: Emit): Promise<{ closed: string }> {
  const cwd = resolveScope(env.root, scope);
  const origins = checkOrigins(interact);
  const paths = browserPaths(env);
  if (!existsSync(join(paths.playwright, "index.mjs")) || !existsSync(paths.chromium)) {
    throw new OpError("failed", "The browser is not installed: run sudo zsh scripts/setup.sh --update-exec");
  }
  const s = prepareSpace(env, scope);
  const driver = driverPath(env);
  if (!existsSync(driver)) throw new OpError("failed", "The browser driver is not installed: run sudo zsh scripts/setup.sh --update-exec");
  const stamp = `${process.pid}-${Date.now()}`;
  const profile = join(s.tmp, `browser-profile-${stamp}`);
  const config: DriverConfig = { ...paths, userDataDir: profile, tmpDir: s.tmp, interact: origins };
  const child = spawnInteractive(env, sandboxed(env, [join(env.layout.nodeBin, "node"), "--disable-warning=ExperimentalWarning", driver], scope), { cwd, scope });
  child.stdin!.write(`${JSON.stringify(config)}\n`);

  const saves = new Map<number, { path: string; abs: string }>();
  const regions = new Map<number, Region>();
  let chain = Promise.resolve();
  let closed = "";
  const finished = new Promise<void>((resolve) => {
    const out = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    out.on("line", (line) => {
      let msg: { id?: number; ok?: boolean; result?: Record<string, unknown>; error?: string; ready?: boolean; fatal?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      chain = chain.then(async () => {
        if (msg.fatal) {
          closed = `browser failed: ${msg.fatal}`;
          emit({ fatal: msg.fatal });
          return;
        }
        if (msg.ready) return emit({ ready: true });
        if (typeof msg.id !== "number") return;
        const png = msg.ok ? msg.result?.png : undefined;
        if (png === undefined) return emit(msg);
        // The driver shares the sandbox with untrusted pages: take only a capture in its own temp dir.
        if (typeof png !== "string" || dirname(png) !== s.tmp.replace(/\/$/, "") || !/^browser-\d+-\d+\.png$/.test(basename(png))) {
          return emit({ id: msg.id, ok: false, error: "The browser returned an unexpected screenshot path" });
        }
        try {
          const { png: _png, ...rest } = msg.result!;
          const image = await toModelImage(env, scope, cwd, png, saves.get(msg.id), regions.get(msg.id));
          emit({ id: msg.id, ok: true, result: { ...rest, ...image } });
        } catch (error) {
          emit({ id: msg.id, ok: false, error: (error as Error).message });
        } finally {
          saves.delete(msg.id);
          regions.delete(msg.id);
        }
      });
    });
    // "close", not "exit": the last replies may still be in the pipe when the process ends.
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-2000)));

  let idle: NodeJS.Timeout | undefined;
  const stop = (reason: string) => {
    closed ||= reason;
    stopInteractive(child);
  };
  const total = setTimeout(() => stop("time limit"), Math.min(Math.max(60_000, timeoutMs), MAX_SESSION_MS));
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop("idle"), IDLE_MS);
  };
  touch();
  const relay = (async () => {
    for await (const line of input) {
      touch();
      let c: DriverCommand & { saveAs?: string; region?: unknown };
      try {
        c = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof c.id !== "number" || !COMMANDS.has(c.cmd)) {
        emit({ id: c?.id ?? null, ok: false, error: "Unknown browser command" });
        continue;
      }
      if (c.cmd === "screenshot") {
        try {
          if (c.saveAs !== undefined) saves.set(c.id, evidencePath(cwd, c.saveAs));
          if (c.region !== undefined) regions.set(c.id, checkRegion(c.region));
        } catch (error) {
          emit({ id: c.id, ok: false, error: (error as Error).message });
          continue;
        }
      }
      const { saveAs: _s, region: _r, ...forward } = c;
      child.stdin!.write(`${JSON.stringify(forward)}\n`);
    }
    // swarmd closed the session: let the driver close Chromium, then make sure.
    child.stdin!.end();
    setTimeout(() => stop("closed"), 10_000).unref();
  })();
  await Promise.race([finished, relay.then(() => finished)]);
  await chain;
  clearTimeout(total);
  clearTimeout(idle);
  rmSync(profile, { recursive: true, force: true });
  return { closed: closed || (child.exitCode === 0 ? "closed" : `browser exited: ${stderr.trim().split("\n").pop() ?? ""}`.slice(0, 500)) };
}
