import { readFileSync, rmSync } from "node:fs";
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
export async function toModelImage(env: ExecEnv, scope: string, cwd: string, png: string, saveAs?: { readonly path: string; readonly abs: string }): Promise<ImageResult> {
  const source = imageSize(readFileSync(png));
  const jpeg = `${png}.jpg`;
  const run = async (argv: string[]) => {
    const r = await runProcess(env, sandboxed(env, argv, scope), { cwd, scope, timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new OpError("failed", `Image conversion failed: ${r.output.trim().slice(-300)}`);
  };
  try {
    await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(MODEL_MAX_SIDE), png, "--out", jpeg]);
    // Evidence for the acceptance report: the same size, a little better quality.
    if (saveAs) await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(MODEL_MAX_SIDE), png, "--out", saveAs.abs]);
    const buf = readFileSync(jpeg);
    const size = imageSize(buf);
    return { jpeg: buf.toString("base64"), width: size.width, height: size.height, sourceWidth: source.width, sourceHeight: source.height, ...(saveAs ? { saved: saveAs.path } : {}) };
  } finally {
    rmSync(jpeg, { force: true });
    rmSync(png, { force: true });
  }
}
