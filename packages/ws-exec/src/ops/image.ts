import { rmSync } from "node:fs";
import { readProduced } from "../paths.ts";
import type { ExecEnv } from "../layout.ts";
import { OpError, type ImageResult } from "../protocol.ts";
import { runProcess } from "../process.ts";
import { sandboxed } from "../sandbox.ts";

/** Longest side of the copy a model sees (R0: 603 px wide was enough for large elements; 1000 keeps small ones). */
export const MODEL_MAX_SIDE = 1000;

/** A PNG's or JPEG's pixel size, from its header. */
export function imageSize(buf: Buffer): { width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  throw new OpError("failed", "Not a PNG or JPEG image");
}

/**
 * Turns a captured PNG into what the model gets (a JPEG, longest side MODEL_MAX_SIDE) and, when asked, a copy
 * saved in the worktree. sips runs in the same sandbox as everything else.
 */
/** A part of the screen to look at closely: [x1, y1, x2, y2], each 0–1000 of the width or height. */
export type Region = readonly [number, number, number, number];

export function checkRegion(region: unknown): Region {
  if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => typeof n === "number" && n >= 0 && n <= 1000)) {
    throw new OpError("bad_request", "region is [x1, y1, x2, y2], each 0–1000");
  }
  const [x1, y1, x2, y2] = region as number[];
  if (x2! - x1! < 20 || y2! - y1! < 20) throw new OpError("bad_request", "The region must be at least 20 × 20 (of 1000)");
  return [x1!, y1!, x2!, y2!];
}

/**
 * With `region`, the full-resolution capture is cropped first and the crop scaled to the model's size:
 * a closer look at small icons and text (R0), not a blow-up of the already shrunk image.
 */
export async function toModelImage(env: ExecEnv, scope: string, cwd: string, png: string, saveAs?: { readonly path: string; readonly abs: string }, region?: Region): Promise<ImageResult> {
  const jpeg = `${png}.jpg`;
  const run = async (argv: string[]) => {
    const r = await runProcess(env, sandboxed(env, argv, scope), { cwd, scope, timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new OpError("failed", `Image conversion failed: ${r.output.trim().slice(-300)}`);
  };
  let full: { width: number; height: number };
  let source: { width: number; height: number };
  try {
    full = imageSize(readProduced(png));
    source = full;
    if (region) {
      const [x1, y1, x2, y2] = region;
      // sips reads an offset of 0 as "none" and crops around the centre instead: start at 1 at least.
      const x = Math.max(1, Math.round((x1 / 1000) * full.width));
      const y = Math.max(1, Math.round((y1 / 1000) * full.height));
      const w = Math.max(1, Math.round(((x2 - x1) / 1000) * full.width));
      const h = Math.max(1, Math.round(((y2 - y1) / 1000) * full.height));
      await run(["/usr/bin/sips", "--cropToHeightWidth", String(h), String(w), "--cropOffset", String(y), String(x), png, "--out", png]);
      source = imageSize(readProduced(png));
      // A small crop is scaled up to the model's size: that is the point of looking closer.
      const scale = MODEL_MAX_SIDE / Math.max(source.width, source.height);
      if (scale > 1) await run(["/usr/bin/sips", "-z", String(Math.round(source.height * scale)), String(Math.round(source.width * scale)), png, "--out", png]);
    }
    await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(MODEL_MAX_SIDE), png, "--out", jpeg]);
    // Evidence for the acceptance report: the same size, a little better quality.
    if (saveAs) await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(MODEL_MAX_SIDE), png, "--out", saveAs.abs]);
    const buf = readProduced(jpeg);
    const size = imageSize(buf);
    return { jpeg: buf.toString("base64"), width: size.width, height: size.height, sourceWidth: full.width, sourceHeight: full.height, ...(region ? { region } : {}), ...(saveAs ? { saved: saveAs.path } : {}) };
  } finally {
    rmSync(jpeg, { force: true });
    rmSync(png, { force: true });
  }
}
