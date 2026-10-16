import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Addresses an agent's browser must never reach: loopback, private, link-local, CGNAT, benchmark,
 * IETF-reserved, multicast, unspecified, and IPv6 forms that embed one of those (mapped, NAT64, 6to4).
 */
export function isBlockedAddress(address: string): boolean {
  // Chrome reports a response's IPv6 server address in URL form: [2606:4700::1]
  const ip = /^\[[^\]]+\]$/.test(address) ? address.slice(1, -1) : address;
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const h = hextets(ip);
    if (!h) return true;
    if (h.every((x) => x === 0) || (h.slice(0, 7).every((x) => x === 0) && h[7] === 1)) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64)
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return isBlockedAddress(v4(h[6]!, h[7]!));
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isBlockedAddress(v4(h[6]!, h[7]!));
    if (h[0] === 0x2002) return isBlockedAddress(v4(h[1]!, h[2]!));
    const first = h[0]!;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

/** Eight 16-bit groups of an IPv6 address (handles :: and a trailing dotted IPv4). */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = dotted[1]!.split(".").map(Number);
    s = s.slice(0, -dotted[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const parts = (x: string | undefined) => (x ? x.split(":").filter(Boolean) : []);
  const left = parts(head);
  const right = parts(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right];
  if (all.length !== 8) return null;
  return all.map((x) => parseInt(x, 16));
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
