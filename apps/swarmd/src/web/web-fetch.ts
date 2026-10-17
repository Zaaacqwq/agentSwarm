import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

/** Limits for one fetch (all hops together). */
export const FETCH_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5, maxChars: 20_000 } as const;
const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv)|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))\b/;

export class FetchError extends Error {}

export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly title: string;
  /** The page as plain text (links kept as "text (url)"). */
  readonly text: string;
}

/**
 * Addresses no fetch may reach: loopback, private, link-local, CGNAT, multicast, documentation and similar ranges.
 * Two lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
 */
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !BLOCKED_V4.check(address, "ipv4") : !BLOCKED_V6.check(address, "ipv6");
}

/** Only https URLs on the default port, without credentials. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError(`Not a URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") throw new FetchError("Only https:// URLs can be fetched");
  if (url.username || url.password) throw new FetchError("URLs with credentials are not allowed");
  if (url.port && url.port !== "443") throw new FetchError("Only the default https port is allowed");
  // Research reads pages; it does not send data. A long query string is how text would leave.
  if (url.search.length > 512) throw new FetchError("The URL's query string is too long (512 characters at most)");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new FetchError("That address is not public");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !isIP(host)) {
    throw new FetchError("That host is not public");
  }
  return url;
}

/** DNS lookup that refuses names resolving to non-public addresses (checked at connect time, so rebinding cannot slip in). */
function safeLookup(hostname: string, options: object, callback: (...args: any[]) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || addresses.length === 0) return callback(new FetchError(`${hostname} resolves to a non-public address`));
    if ((options as { all?: boolean }).all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      lookup: safeLookup as never,
      signal,
      headers: {
        "user-agent": "agentSwarm-research/1.0 (+https://github.com)",
        accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
      },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** Fetches a public web page as text. Follows up to 5 redirects, checking every hop. */
export async function fetchPage(raw: string, outer?: AbortSignal): Promise<FetchedPage> {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(FETCH_LIMITS.timeoutMs)]) : AbortSignal.timeout(FETCH_LIMITS.timeoutMs);
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await get(url, signal).catch((e: Error) => {
      throw e instanceof FetchError ? e : new FetchError(`Could not fetch ${url.host}: ${e.message}`);
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= FETCH_LIMITS.maxRedirects) throw new FetchError("Too many redirects");
      url = checkUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    const type = String(res.headers["content-type"] ?? "text/html").toLowerCase();
    if (!TEXT_TYPES.test(type)) {
      res.resume();
      throw new FetchError(`Not a text page (${type.split(";")[0]})`);
    }
    const body = await readBody(res, signal);
    const charset = /charset=([^;]+)/.exec(type)?.[1]?.trim() ?? "utf-8";
    let decoded: string;
    try {
      decoded = new TextDecoder(charset).decode(body);
    } catch {
      decoded = new TextDecoder("utf-8").decode(body);
    }
    const html = type.includes("html") || (type.includes("xml") && /<html[\s>]/i.test(decoded));
    return { url: url.toString(), status, title: html ? titleOf(decoded) : "", text: html ? htmlToText(decoded, url) : decoded };
  }
}

async function readBody(res: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
  let stream: Readable = res;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
  else if (encoding === "deflate") stream = res.pipe(createInflate());
  else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new FetchError("Timed out");
      size += (chunk as Buffer).length;
      if (size > FETCH_LIMITS.maxBytes) {
        chunks.push((chunk as Buffer).subarray(0, (chunk as Buffer).length - (size - FETCH_LIMITS.maxBytes)));
        break;
      }
      chunks.push(chunk as Buffer);
    }
  } finally {
    res.destroy();
  }
  return Buffer.concat(chunks);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/*
 * Pages are untrusted and up to 2 MB, so they are scanned once from left to right with indexOf:
 * no regular expression runs over the whole page (backtracking on unclosed tags would be quadratic).
 */
const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "head", "object"]);
const BLOCK_END = new Set(["p", "div", "section", "article", "header", "footer", "li", "ul", "ol", "table", "tr", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
const TAG_NAME = /^(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})/;
const HREF = /\bhref\s{0,10}=\s{0,10}(?:"([^"]{0,4000})"|'([^']{0,4000})'|([^\s"'>]{1,4000}))/i;

function titleOf(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return "";
  const gt = lower.indexOf(">", open);
  const close = gt === -1 ? -1 : lower.indexOf("</title", gt);
  if (close === -1) return "";
  return decodeEntities(html.slice(gt + 1, close)).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** A readable text version of a page: no scripts or styles, block elements on their own lines, links kept as "text (url)". */
export function htmlToText(html: string, base?: URL): string {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  let link: { href: string; at: number } | null = null;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    // Not a tag ("a < b"): keep the character and move on, without searching ahead for ">".
    const m = TAG_NAME.exec(html.slice(lt + 1, lt + 34));
    if (!m) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = html.slice(lt + 1, gt);
    i = gt + 1;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!closing && SKIP.has(name)) {
      // Skip to its closing tag; "<" inside a script is not a tag.
      if (!tag.endsWith("/")) {
        const end = lower.indexOf(`</${name}`, i);
        const close = end === -1 ? -1 : html.indexOf(">", end);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const h = HREF.exec(tag.length > 8000 ? tag.slice(0, 8000) : tag);
        link = { href: decodeEntities(h?.[1] ?? h?.[2] ?? h?.[3] ?? ""), at: out.length };
      } else if (link) {
        const label = out.slice(link.at).join("").trim();
        let abs = "";
        try {
          abs = base ? new URL(link.href, base).toString() : link.href;
        } catch {
          abs = "";
        }
        if (label && abs.startsWith("http")) out.push(` (${abs})`);
        link = null;
      }
    } else if (name === "br" || name === "hr") out.push("\n");
    else if (name === "li" && !closing) out.push("\n- ");
    else if (/^h[1-6]$/.test(name) && !closing) out.push(`\n\n${"#".repeat(Number(name[1]))} `);
    else if ((name === "td" || name === "th") && !closing) out.push(" | ");
    else if (closing && BLOCK_END.has(name)) out.push("\n");
  }
  const text = decodeEntities(out.join(""));
  return text.split("\n").map((l) => l.replace(/[ \t\f\v\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
