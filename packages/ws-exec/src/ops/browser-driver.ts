// The browser driver (R6): runs inside the workstation's sandbox as its own process, one per session. ws-exec
// writes one JSON command per line on stdin and relays each reply line; the first line is the configuration.
// Playwright talks to Chromium over a pipe (no debugging port another workstation could reach).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface DriverConfig {
  readonly playwright: string;
  readonly chromium: string;
  readonly userDataDir: string;
  readonly tmpDir: string;
  /** Origins (scheme://host[:port]) besides local ones where the agent may click and type. */
  readonly interact: readonly string[];
}

export type DriverCommand =
  | { id: number; cmd: "open"; url: string }
  | { id: number; cmd: "snapshot" }
  | { id: number; cmd: "click"; ref: string }
  | { id: number; cmd: "fill"; ref: string; text: string }
  | { id: number; cmd: "press"; key: string }
  | { id: number; cmd: "back" }
  | { id: number; cmd: "screenshot"; fullPage?: boolean }
  | { id: number; cmd: "console" };

const PRIVATE = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16], ["0.0.0.0", 8], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

/**
 * Loopback is allowed (a project's own dev server; seatbelt still refuses the denied ports and swarmd's), the
 * public internet too. LAN, tailnet, link-local and multicast addresses are not: those are the person's machines.
 */
export function addressAllowed(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const v4 = mapped ?? (isIP(ip) === 4 ? ip : null);
  if (v4) return !PRIVATE.check(v4, "ipv4");
  if (isIP(ip) === 6) return !PRIVATE.check(ip, "ipv6");
  return false;
}

export const isLoopbackHost = (host: string) => host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "[::1]";

const resolved = new Map<string, { ok: boolean; at: number }>();

/** Checked on every request, after resolving the name, so a name that points at the LAN is refused too. */
export async function urlAllowed(raw: string, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || raw === "about:blank") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return true;
  if (isIP(host)) return addressAllowed(host);
  const cached = resolved.get(host);
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try {
    const addresses = await resolve(host);
    ok = addresses.length > 0 && addresses.every(addressAllowed);
  } catch {
    ok = false;
  }
  resolved.set(host, { ok, at: Date.now() });
  return ok;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/** Clicking and typing: on local pages and the origins the project lists. Elsewhere the agent only reads. */
export function interactAllowed(pageUrl: string, interact: readonly string[]): boolean {
  if (pageUrl === "about:blank" || pageUrl.startsWith("data:")) return true;
  try {
    const url = new URL(pageUrl);
    return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, "")) || interact.includes(url.origin);
  } catch {
    return false;
  }
}

const REF = /^[A-Za-z0-9]{1,16}$/;
const KEY = /^[A-Za-z0-9+]{1,40}$/;
const MAX_SNAPSHOT = 40_000;

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  const config = JSON.parse(first.value) as DriverConfig;
  const { chromium } = (await import(join(config.playwright, "index.mjs"))) as typeof import("playwright-core");
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    executablePath: config.chromium,
    headless: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const events: string[] = [];
  const note = (text: string) => {
    events.push(text.slice(0, 500));
    if (events.length > 100) events.shift();
  };
  await context.route("**/*", async (route) => (await urlAllowed(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
  await context.routeWebSocket(/.*/, async (ws) => (await urlAllowed(ws.url()) ? ws.connectToServer() : ws.close()));
  let page = context.pages()[0] ?? (await context.newPage());
  const watch = (p: typeof page) => {
    p.on("console", (m) => m.type() === "error" && note(`console error: ${m.text()}`));
    p.on("pageerror", (e) => note(`page error: ${e.message}`));
    p.on("requestfailed", (r) => note(`request failed: ${r.url()} (${r.failure()?.errorText ?? "?"})`));
  };
  watch(page);
  context.on("page", (p) => {
    page = p;
    watch(p);
  });
  const reply = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);
  reply({ ready: true });
  const where = async () => ({ url: page.url(), title: await page.title().catch(() => "") });
  const mayInteract = () => {
    if (!interactAllowed(page.url(), config.interact)) throw new Error(`Only reading is allowed on ${new URL(page.url()).origin}: click and type on the project's local dev server or the test sites in its profile`);
  };
  const settle = () => page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
  for (let next = await lines.next(); !next.done; next = await lines.next()) {
    let c: DriverCommand;
    try {
      c = JSON.parse(next.value) as DriverCommand;
    } catch {
      continue;
    }
    try {
      let result: unknown;
      switch (c.cmd) {
        case "open": {
          if (!(await urlAllowed(c.url))) throw new Error("That address is not allowed (local network, tailnet, or not http/https)");
          const res = await page.goto(c.url, { waitUntil: "load", timeout: 30_000 });
          result = { ...(await where()), status: res?.status() ?? null };
          break;
        }
        case "snapshot": {
          const text = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 });
          result = { ...(await where()), snapshot: text.length > MAX_SNAPSHOT ? `${text.slice(0, MAX_SNAPSHOT)}\n… (cut)` : text };
          break;
        }
        case "click":
        case "fill": {
          if (!REF.test(c.ref)) throw new Error("Use an element ref from the snapshot, e.g. e12");
          mayInteract();
          const target = page.locator(`aria-ref=${c.ref}`);
          if (c.cmd === "click") await target.click({ timeout: 10_000 });
          else await target.fill(c.text.slice(0, 5000), { timeout: 10_000 });
          await settle();
          result = await where();
          break;
        }
        case "press": {
          if (!KEY.test(c.key)) throw new Error("Use a key name like Enter, Tab or Control+a");
          mayInteract();
          await page.keyboard.press(c.key);
          await settle();
          result = await where();
          break;
        }
        case "back":
          await page.goBack({ timeout: 15_000 });
          result = await where();
          break;
        case "screenshot": {
          const png = join(config.tmpDir, `browser-${process.pid}-${Date.now()}.png`);
          // A whole long page squeezed to 1000 px would be unreadable: at most three screens.
          const height = c.fullPage ? Math.min(await page.evaluate("document.documentElement.scrollHeight") as number, 2400) : 800;
          await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1280, height }, fullPage: Boolean(c.fullPage), timeout: 15_000 });
          result = { png, ...(await where()) };
          break;
        }
        case "console":
          result = { events: events.splice(0) };
          break;
        default:
          throw new Error("Unknown browser command");
      }
      reply({ id: c.id, ok: true, result });
    } catch (error) {
      reply({ id: c.id, ok: false, error: String((error as Error).message ?? error).split("\n")[0]!.slice(0, 500) });
    }
  }
  await context.close();
}

if (process.argv[1]?.endsWith("browser-driver.ts")) {
  main().then(() => process.exit(0), (error) => {
    process.stdout.write(`${JSON.stringify({ fatal: String((error as Error)?.message ?? error).slice(0, 500) })}\n`);
    process.exit(1);
  });
}
