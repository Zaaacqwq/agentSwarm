import { Type } from "typebox";
import { defineHiveTool, type AgentContext, type AnyHiveTool, type Toolpack, type ToolResult } from "../toolpack.ts";
import type { DesktopAction, DesktopPort } from "./desktop-port.ts";

export const DESKTOP_PACK_ID = "core.desktop";

const GUIDANCE = [
  "Desktop: you may see and drive this Mac's screen only inside a session a person approved.",
  "Call desktop_acquire(reason) first and wait; call desktop_release as soon as you are done. Only one agent holds the desktop at a time.",
  "Prefer desktop_ui (the front app's accessibility tree with numbered elements) and desktop_press over pixel clicks.",
  "Screenshot coordinates: pixels of that display's screenshot (grid lines every 100 px); pass the same display to desktop_click.",
  "System Settings, Keychain Access, Terminal, password managers and the Hive UI are always off limits.",
].join("\n");

const Display = Type.Optional(Type.Integer({ minimum: 0, maximum: 7, description: "Display index (0 = main)" }));
const Coord = Type.Number({ minimum: 0, maximum: 4000 });

async function attempt(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { text: await work() };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export function createDesktopPack(port: DesktopPort, health: () => Promise<{ available: boolean; reason?: string }>): Toolpack {
  const act = async (ctx: AgentContext, action: DesktopAction): Promise<ToolResult> => {
    try {
      const o = await port.act(ctx, action);
      if (!o.screenshot) return { text: o.text };
      return { text: o.text, images: [{ data: o.screenshot.data, mimeType: "image/jpeg" }], details: { screenshotId: o.screenshot.id } };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  const tools: AnyHiveTool[] = [
    defineHiveTool({
      name: "desktop_acquire", label: "Request desktop", access: "claim",
      description: "Ask a person for a desktop control session and wait for approval. Needed before any other desktop tool.",
      parameters: Type.Object({
        reason: Type.String({ minLength: 5, maxLength: 300, description: "What you will do, shown to the person" }),
        minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      }),
      execute: (ctx, p) => attempt(() => port.acquire(ctx, p.reason.trim(), p.minutes ?? 15)),
    }),
    defineHiveTool({
      name: "desktop_release", label: "Release desktop", access: "claim",
      description: "End your desktop control session now.",
      parameters: Type.Object({}),
      execute: (ctx) => attempt(() => port.release(ctx)),
    }),
    defineHiveTool({
      name: "desktop_screenshot", label: "Screenshot", access: "r",
      description: "Screenshot of a display (max 1280 wide, with a 100 px coordinate grid).",
      parameters: Type.Object({ display: Display }),
      execute: (ctx, p) => act(ctx, { cmd: "screenshot", ...(p.display !== undefined ? { display: p.display } : {}) }),
    }),
    defineHiveTool({
      name: "desktop_click", label: "Click", access: "w",
      description: "Click at screenshot coordinates.",
      parameters: Type.Object({
        x: Coord, y: Coord, display: Display,
        button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
        double: Type.Optional(Type.Boolean()),
      }),
      execute: (ctx, p) => act(ctx, { cmd: "click", x: p.x, y: p.y, ...(p.display !== undefined ? { display: p.display } : {}), ...(p.button ? { button: p.button } : {}), ...(p.double ? { count: 2 } : {}) }),
    }),
    defineHiveTool({
      name: "desktop_type", label: "Type", access: "w",
      description: "Type text into the focused field of the front app.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }),
      execute: (ctx, p) => act(ctx, { cmd: "type", text: p.text }),
    }),
    defineHiveTool({
      name: "desktop_key", label: "Key", access: "w",
      description: "Press a key combination, e.g. \"cmd+s\", \"return\", \"shift+tab\".",
      parameters: Type.Object({ combo: Type.String({ minLength: 1, maxLength: 40 }) }),
      execute: (ctx, p) => act(ctx, { cmd: "key", combo: p.combo }),
    }),
    defineHiveTool({
      name: "desktop_scroll", label: "Scroll", access: "w",
      description: "Scroll by pixels (dy > 0 scrolls down), optionally at screenshot coordinates.",
      parameters: Type.Object({ dx: Type.Optional(Type.Integer()), dy: Type.Optional(Type.Integer()), x: Type.Optional(Coord), y: Type.Optional(Coord), display: Display }),
      execute: (ctx, p) => act(ctx, { cmd: "scroll", ...p }),
    }),
    defineHiveTool({
      name: "desktop_ui", label: "Read UI", access: "r",
      description: "The front app's (or a named app's) accessibility tree: numbered elements with screenshot coordinates.",
      parameters: Type.Object({ app: Type.Optional(Type.String({ maxLength: 80, description: "App name or bundle id" })) }),
      execute: (ctx, p) => act(ctx, { cmd: "ui", ...(p.app ? { app: p.app } : {}) }),
    }),
    defineHiveTool({
      name: "desktop_press", label: "Press element", access: "w",
      description: "Press a numbered element from the latest desktop_ui.",
      parameters: Type.Object({ element: Type.Integer({ minimum: 1 }) }),
      execute: (ctx, p) => act(ctx, { cmd: "press", element: p.element }),
    }),
  ];
  return { id: DESKTOP_PACK_ID, label: "Desktop", tools: () => tools, leases: ["desktop"], healthcheck: health, guidance: GUIDANCE };
}
