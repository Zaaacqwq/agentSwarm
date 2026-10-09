import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Addresses an agent's browser must never reach: loopback, private, link-local, CGNAT, multicast, unspecified. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isBlockedAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

export type UrlVerdict = { ok: true; host: string } | { ok: false; reason: string };

/** Only public http(s). Hostnames are resolved and every address is checked (no DNS tricks into the LAN). */
export async function checkUrl(raw: string, resolve: (host: string) => Promise<string[]> = defaultResolve, allowHosts: readonly string[] = []): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `${url.protocol} URLs are not allowed` };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowHosts.includes(host)) return { ok: true, host };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Local hosts are not allowed" };
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) return { ok: false, reason: `Cannot resolve ${host}` };
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "Private and local network addresses are not allowed" };
  return { ok: true, host };
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address);
}

/** Approved hosts cover subdomains too: approving example.com covers www.example.com. */
export function hostApproved(host: string, approved: readonly string[]): boolean {
  return approved.some((a) => host === a || host.endsWith(`.${a}`));
}
