import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** How many screenshots stay in an agent's context; older ones become a line of text (R6 plan, section 6). */
export const KEEP_IMAGES = 3;

const REMOVED = "[An earlier screenshot was removed to save context; take a new one if you need to see the screen.]";

/**
 * A copy of the messages with all but the newest `keep` images replaced by a note. Used before every model
 * request and when the session is saved, so neither the context nor the database grows with each screenshot.
 */
export function keepRecentImages(messages: readonly AgentMessage[], keep = KEEP_IMAGES): AgentMessage[] {
  let seen = 0;
  const out: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some((c) => (c as { type?: string }).type === "image")) {
      out.push(m);
      continue;
    }
    const next = [...content].reverse().map((c) => {
      if ((c as { type?: string }).type !== "image") return c;
      seen += 1;
      return seen <= keep ? c : { type: "text", text: REMOVED };
    }).reverse();
    out.push({ ...m, content: next } as AgentMessage);
  }
  return out.reverse();
}

/**
 * Keeps a screenshot for the dashboard as the run's next NNN.jpg. Numbered from what is on disk, so the
 * simulator, the browser and the desktop of one run never write the same name.
 */
export function saveScreen(dir: string, jpeg: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const last = readdirSync(dir).map((f) => /^(\d{3,6})\.jpg$/.exec(f)?.[1]).filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
  const file = `${String(last + 1).padStart(3, "0")}.jpg`;
  writeFileSync(join(dir, file), jpeg, { flag: "wx" });
  return file;
}
