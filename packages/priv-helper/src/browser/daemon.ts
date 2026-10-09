#!/usr/bin/env bun
// Headless Chrome for one agent, running as its workstation user inside the seatbelt profile.
// Controlled over a private Unix socket; Chrome itself is driven over a pipe (no debugging port).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, type BrowserContext, type Page, type Request } from "playwright-core";
import { checkUrl, hostApproved } from "./url-guard.ts";
import type { BrowserCommand, BrowserRequest, BrowserResponse } from "./protocol.ts";

const [socketPath, profileDir, allowArg] = process.argv.slice(2);
// Test-only: hosts exempt from the private-address block (hive-exec passes them from its fixed layout).
const allowHosts = allowArg ? allowArg.split(",").filter(Boolean) : [];
if (!socketPath || !profileDir) throw new Error("usage: daemon <socket> <profile-dir>");
const IDLE_MS = 15 * 60 * 1000;
const FULL_PAGE_MAX = 4000;
const SNAPSHOT_MAX = 12_000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

mkdirSync(profileDir, { recursive: true, mode: 0o700 });
const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1280, height: 800 },
  acceptDownloads: false,
  // Chrome cannot apply its own seatbelt inside sandbox-exec (it hangs), so isolation comes from
  // hive-exec: the workstation user plus the outer sandbox profile.
  chromiumSandbox: false,
  args: ["--disable-features=Translate,AutofillServerCommunication", "--no-first-run", "--disable-sync", "--disable-crash-reporter"],
});

let approvedHosts: readonly string[] = [];
let blockedWrites: string[] = [];
/** A blocked write that belongs to the page itself (a form post or the page's own API), not a tracker. */
let blockedFirstParty: string | null = null;
const verdicts = new Map<string, boolean>();

// Every request from every page: public http(s) only; writes need an approved host.
await context.route("**/*", async (route) => {
  const req: Request = route.request();
  const url = req.url();
  if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
  const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
  let allowed = verdicts.get(origin);
  if (allowed === undefined) {
    allowed = (await checkUrl(url, undefined, allowHosts)).ok;
    verdicts.set(origin, allowed);
  }
  if (!allowed) return route.abort("blockedbyclient");
  if (!READ_METHODS.has(req.method())) {
    const host = new URL(url).hostname;
    if (!hostApproved(host, approvedHosts)) {
      blockedWrites.push(`${req.method()} ${host}`);
      const pageHost = (() => { try { return new URL(req.frame().url()).hostname; } catch { return ""; } })();
      if (req.isNavigationRequest() || host === pageHost) blockedFirstParty ??= host;
      return route.abort("blockedbyclient");
    }
  }
  return route.continue();
});

const page = async (): Promise<Page> => context.pages().at(-1) ?? (await context.newPage());

async function result(p: Page, extra: Partial<Extract<BrowserResponse, { ok: true }>> = {}): Promise<BrowserResponse> {
  const writes = blockedWrites;
  const firstParty = blockedFirstParty;
  blockedWrites = [];
  blockedFirstParty = null;
  return {
    ok: true, url: p.url(), title: await p.title().catch(() => ""), ...extra,
    ...(writes.length ? { blockedWrites: [...new Set(writes)] } : {}),
    ...(firstParty ? { blockedSite: firstParty } : {}),
  };
}

async function hostOf(p: Page): Promise<string> {
  try {
    return new URL(p.url()).hostname;
  } catch {
    return "";
  }
}

/** Refs come from the latest snapshot; a stale one fails fast instead of waiting for a timeout. */
async function byRef(p: Page, ref: string) {
  const target = p.getByRef(ref);
  if ((await target.count()) === 0) throw new Error(`No element with ref ${ref}; take a new browser_snapshot`);
  return target;
}

async function run(command: BrowserCommand): Promise<BrowserResponse> {
  const p = await page();
  switch (command.cmd) {
    case "ping":
      return result(p);
    case "open": {
      const v = await checkUrl(command.url, undefined, allowHosts);
      if (!v.ok) return { ok: false, error: v.reason };
      await p.goto(command.url, { timeout: 30_000, waitUntil: "domcontentloaded" });
      return result(p);
    }
    case "snapshot": {
      const snap = await p.ariaSnapshot({ mode: "ai", timeout: 15_000 });
      return result(p, { text: snap.length > SNAPSHOT_MAX ? `${snap.slice(0, SNAPSHOT_MAX)}\n… [snapshot truncated]` : snap });
    }
    case "click":
      await (await byRef(p, command.ref)).click({ timeout: 10_000 });
      await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      return result(p);
    case "type": {
      const target = await byRef(p, command.ref);
      const isPassword = (await target.getAttribute("type", { timeout: 5_000 }).catch(() => null)) === "password";
      const host = await hostOf(p);
      if ((isPassword || command.submit) && !hostApproved(host, approvedHosts)) {
        return { ok: false, error: "Needs approval", needsApproval: { host, reason: isPassword ? "typing into a password field" : "submitting a form" } };
      }
      await target.fill(command.text, { timeout: 10_000 });
      if (command.submit) {
        await target.press("Enter");
        await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      }
      return result(p);
    }
    case "select":
      await (await byRef(p, command.ref)).selectOption(command.value, { timeout: 10_000 });
      return result(p);
    case "screenshot": {
      const viewport = p.viewportSize() ?? { width: 1280, height: 800 };
      // Full pages are capped so one screenshot cannot become an enormous image for the model.
      const height = command.full ? Math.min(Number(await p.evaluate("document.documentElement.scrollHeight").catch(() => viewport.height)) || viewport.height, FULL_PAGE_MAX) : viewport.height;
      const buf = await p.screenshot({
        type: "jpeg", quality: 70, timeout: 20_000,
        ...(command.full ? { fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height } } : {}),
      });
      return result(p, { image: buf.toString("base64"), width: viewport.width, height });
    }
    case "back":
      await p.goBack({ timeout: 15_000 }).catch(() => null);
      return result(p);
    case "tabs":
      return result(p, { text: (await Promise.all(context.pages().map(async (t, i) => `${i}: ${await t.title().catch(() => "")} — ${t.url()}`))).join("\n") });
    case "shutdown":
      setTimeout(() => void shutdown(), 10);
      return result(p);
  }
}

let idle: ReturnType<typeof setTimeout> = setTimeout(() => void shutdown(), IDLE_MS);
let queue: Promise<unknown> = Promise.resolve();

async function shutdown(): Promise<void> {
  // Chrome exits on its own once our end of its pipe closes, so a hung close is safe to cut short.
  setTimeout(() => process.exit(0), 5_000).unref();
  await context.close().catch(() => {});
  rmSync(socketPath!, { force: true });
  process.exit(0);
}

if (existsSync(socketPath)) rmSync(socketPath, { force: true });
// node:net buffers large writes for us (Bun.listen's write may be partial).
createServer((conn) => {
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      clearTimeout(idle);
      idle = setTimeout(() => void shutdown(), IDLE_MS);
      // One command at a time per agent browser.
      queue = queue.then(async () => {
        let response: BrowserResponse;
        try {
          const req = JSON.parse(line) as BrowserRequest;
          approvedHosts = req.approvedHosts ?? [];
          response = await run(req.command);
        } catch (error) {
          response = { ok: false, error: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300) };
        }
        if (!conn.destroyed) conn.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}).listen(socketPath, () => process.stdout.write("ready\n"));

