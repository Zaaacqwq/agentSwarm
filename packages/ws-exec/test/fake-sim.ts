import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Layout } from "../src/layout.ts";

const SOURCE = join(import.meta.dirname, "fake-sim.mjs");
export const UI_FIXTURE = join(import.meta.dirname, "..", "..", "..", "apps", "swarmd", "test", "fixtures", "axe-describe-settings.json");

export interface FakeSim {
  /** Every call the fakes got, in order: [tool, ...args] (axe type records its stdin as the last item). */
  calls(): string[][];
  devices(): { udid: string; name: string; state: string; runtime: string; deviceTypeIdentifier: string }[];
}

/**
 * Fake xcrun (simctl), axe and xcodebuild where ws-exec looks for them. They keep their state in the
 * workstation's cache directory: the only place every scope's sandbox may write.
 */
export function installFakeSim(layout: Layout, cacheDir: string): FakeSim {
  const tools = layout.toolsDir;
  for (const d of [join(tools, "axe"), join(tools, "bin"), dirname(layout.xcrun), cacheDir]) mkdirSync(d, { recursive: true });
  copyFileSync(SOURCE, join(tools, "fake-sim.mjs"));
  copyFileSync(UI_FIXTURE, join(tools, "ui.json"));
  writeFileSync(join(tools, "shot.png"), png(60, 130));
  const wrapper = (name: string) => `#!/bin/sh\nexec "${process.execPath}" "${join(tools, "fake-sim.mjs")}" ${name} "${tools}" "$@"\n`;
  for (const [file, name] of [[layout.xcrun, "xcrun"], [join(tools, "axe", "axe"), "axe"], [join(tools, "bin", "xcodebuild"), "xcodebuild"]] as const) {
    writeFileSync(file, wrapper(name));
    chmodSync(file, 0o755);
  }
  const state = join(cacheDir, "fake-sim.json");
  const read = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { devices: [], calls: [] });
  return { calls: () => read().calls, devices: () => read().devices };
}

/** A valid RGB PNG of the given size (sips has to be able to read it). */
export function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([x * 4, y * 2, 128], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
