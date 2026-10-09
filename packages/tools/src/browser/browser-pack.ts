import { Type } from "typebox";
import { defineHiveTool, type AnyHiveTool, type ShareScreenshot, type Toolpack, type ToolResult } from "../toolpack.ts";
import type { BrowserAction, BrowserOutcome, BrowserPort } from "./browser-port.ts";

export const BROWSER_PACK_ID = "core.browser";

const GUIDANCE = [
  "Browser: you have a private headless Chrome on your workstation; it keeps cookies between turns.",
  "Prefer browser_snapshot (accessibility tree with [ref=…] ids) over screenshots; refs change after every navigation, so snapshot again.",
  "Only public http(s) sites are reachable. Submitting forms or typing into password fields needs a person's approval for that site: the tool asks and waits for you.",
  "Never type credentials you were not explicitly given. Use browser_screenshot when a person needs to see the page.",
].join("\n");

const Ref = Type.String({ pattern: "^[a-z0-9]{1,16}$", description: "Element ref from the latest browser_snapshot, e.g. e12" });

function describe(o: BrowserOutcome, lead: string): string {
  const lines = [`${lead} ${o.title ? `"${o.title}" — ` : ""}${o.url}`];
  if (o.approval) lines.push(o.approval);
  if (o.blockedWrites?.length) lines.push(`Blocked writes (read-only until approved): ${o.blockedWrites.join(", ")}`);
  if (o.text) lines.push(o.text);
  return lines.join("\n");
}

/** Shares a screenshot when asked; returns the note to append to the tool result. */
export function posted(ctx: Parameters<ShareScreenshot>[0], share: ShareScreenshot | undefined, screenshotId: string, postTo: { channelId: string; caption: string } | undefined): string {
  if (!postTo) return "";
  if (!share) return "\nCould not post it: sharing is unavailable.";
  try {
    return `\nPosted it in ${postTo.channelId} as message ${share(ctx, screenshotId, postTo.channelId, postTo.caption).id}.`;
  } catch (error) {
    return `\nCould not post it: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createBrowserPack(port: BrowserPort, health: () => Promise<{ available: boolean; reason?: string }>, share?: ShareScreenshot): Toolpack {
  const run = async (ctx: Parameters<BrowserPort["run"]>[0], action: BrowserAction, lead: string, postTo?: { channelId: string; caption: string }): Promise<ToolResult> => {
    try {
      const o = await port.run(ctx, action);
      if (!o.screenshot) return { text: describe(o, lead) };
      return {
        text: describe(o, lead) + `\n(screenshot ${o.screenshot.width}×${o.screenshot.height} attached)` + posted(ctx, share, o.screenshot.id, postTo),
        images: [{ data: o.screenshot.data, mimeType: "image/jpeg" }],
        details: { screenshotId: o.screenshot.id },
      };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  const tools: AnyHiveTool[] = [
    defineHiveTool({
      name: "browser_open", label: "Open page", access: "r",
      description: "Open a public http(s) URL in your browser.",
      parameters: Type.Object({ url: Type.String({ minLength: 8, maxLength: 2000 }) }),
      execute: (ctx, p) => run(ctx, { cmd: "open", url: p.url }, "Opened"),
    }),
    defineHiveTool({
      name: "browser_snapshot", label: "Read page", access: "r",
      description: "The current page as an accessibility tree: text plus [ref=…] ids for browser_click / browser_type.",
      parameters: Type.Object({}),
      execute: (ctx) => run(ctx, { cmd: "snapshot" }, "Page"),
    }),
    defineHiveTool({
      name: "browser_click", label: "Click", access: "w",
      description: "Click an element by its ref from the latest snapshot.",
      parameters: Type.Object({ ref: Ref }),
      execute: (ctx, p) => run(ctx, { cmd: "click", ref: p.ref }, "Clicked; now at"),
    }),
    defineHiveTool({
      name: "browser_type", label: "Type", access: "w",
      description: "Fill a text field by ref (replaces its content). submit=true presses Enter afterwards.",
      parameters: Type.Object({ ref: Ref, text: Type.String({ maxLength: 4000 }), submit: Type.Optional(Type.Boolean()) }),
      execute: (ctx, p) => run(ctx, { cmd: "type", ref: p.ref, text: p.text, ...(p.submit ? { submit: true } : {}) }, "Typed; now at"),
    }),
    defineHiveTool({
      name: "browser_select", label: "Select", access: "w",
      description: "Choose an option in a select element by ref.",
      parameters: Type.Object({ ref: Ref, value: Type.String({ maxLength: 200 }) }),
      execute: (ctx, p) => run(ctx, { cmd: "select", ref: p.ref, value: p.value }, "Selected; now at"),
    }),
    defineHiveTool({
      name: "browser_screenshot", label: "Screenshot", access: "r",
      description: "Screenshot of the page (1280 wide), attached for you and kept in the activity log. post_to also posts it in a chat.",
      parameters: Type.Object({
        full: Type.Optional(Type.Boolean({ description: "Whole page instead of the viewport" })),
        post_to: Type.Optional(Type.String({ description: "Channel id to post the screenshot in, e.g. to show a person" })),
        caption: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      execute: (ctx, p) => run(ctx, { cmd: "screenshot", ...(p.full ? { full: true } : {}) }, "Screenshot of", p.post_to ? { channelId: p.post_to, caption: p.caption ?? "" } : undefined),
    }),
    defineHiveTool({
      name: "browser_back", label: "Back", access: "r",
      description: "Go back one page.",
      parameters: Type.Object({}),
      execute: (ctx) => run(ctx, { cmd: "back" }, "Back at"),
    }),
    defineHiveTool({
      name: "browser_tabs", label: "Tabs", access: "r",
      description: "List open tabs.",
      parameters: Type.Object({}),
      execute: (ctx) => run(ctx, { cmd: "tabs" }, "Current tab:"),
    }),
  ];
  return { id: BROWSER_PACK_ID, label: "Browser", tools: () => tools, healthcheck: health, guidance: GUIDANCE };
}
