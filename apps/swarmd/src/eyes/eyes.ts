import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { RunNeed } from "@agentswarm/contracts";
import type { ProjectProfile } from "../db/schema.ts";
import type { ImageResult, SimBuildResult, SimDevice, UiElement } from "@agentswarm/ws-exec";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { BrowserSession } from "./browser-session.ts";
import { formatScreen, numberElements, type Screen } from "./ui-tree.ts";

/** Evidence screenshots one run may save into the worktree (R6 plan, decision 3). */
export const MAX_EVIDENCE = 20;
/** Taps start animations; the screen is read after they settle. */
const SETTLE_MS = 1500;
const BUILD_TIMEOUT_MS = 1_800_000;

export interface EyesDeps {
  readonly backend: WorkstationBackend;
  readonly workstation: string;
  readonly scope: string;
  readonly needs: readonly RunNeed[];
  readonly profile: ProjectProfile | null;
  /** Where this run's screenshots are kept for the dashboard: <data>/screens/<runId>. */
  readonly screensDir: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Details = { screen?: string } | undefined;
const text = (t: string): AgentToolResult<Details> => ({ content: [{ type: "text", text: t }], details: undefined });

/**
 * A run's simulator and browser (R6). Both start on first use and end with close(): the simulator is shut
 * down and erased, the browser session closed. Every tool works on this workstation's own device and browser.
 */
export class Eyes {
  private readonly deps: EyesDeps;
  private device: SimDevice | null = null;
  private screen: Screen | null = null;
  private bundleId: string | null = null;
  private browser: BrowserSession | null = null;
  private last: "simulator" | "browser" | null = null;
  private evidence = 0;
  private shots: number;

  constructor(deps: EyesDeps) {
    this.deps = deps;
    try {
      this.shots = readdirSync(deps.screensDir).length;
    } catch {
      this.shots = 0;
    }
  }

  get used(): boolean {
    return Boolean(this.device || this.browser);
  }

  private call<T>(request: Parameters<WorkstationBackend["call"]>[1], signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return this.deps.backend.call<T>(this.deps.workstation, request, { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async booted(signal?: AbortSignal): Promise<string> {
    if (this.device) return "";
    const deviceType = this.deps.profile?.ios?.deviceType;
    this.device = await this.call<SimDevice>({ op: "sim.boot", scope: this.deps.scope, ...(deviceType ? { deviceType } : {}) }, signal, 300_000);
    return `(Simulator ${this.device.name} started: ${this.device.deviceType.split(".").pop()}, ${this.device.runtime.split(".").pop()}, ${Math.round(this.device.bootMs / 1000)} s.)\n`;
  }

  private session(): BrowserSession {
    this.browser ??= new BrowserSession(this.deps.backend, this.deps.workstation, this.deps.scope, this.deps.profile?.testSites ?? []);
    return this.browser;
  }

  private settle(): Promise<void> {
    return (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(SETTLE_MS);
  }

  private saveAs(path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    if (this.evidence >= MAX_EVIDENCE) throw new Error(`At most ${MAX_EVIDENCE} evidence screenshots per run; pick the ones that matter`);
    this.evidence += 1;
    return path;
  }

  /** The model gets the image; the dashboard gets a copy under the run's screens. */
  private image(note: string, img: ImageResult): AgentToolResult<Details> {
    mkdirSync(this.deps.screensDir, { recursive: true });
    this.shots += 1;
    const file = `${String(this.shots).padStart(3, "0")}.jpg`;
    writeFileSync(join(this.deps.screensDir, file), Buffer.from(img.jpeg, "base64"));
    const saved = img.saved ? ` Saved as evidence: ${img.saved}.` : "";
    return { content: [{ type: "text", text: `${note}${saved}` }, { type: "image", data: img.jpeg, mimeType: "image/jpeg" }], details: { screen: file } };
  }

  private async readScreen(signal?: AbortSignal): Promise<Screen> {
    this.screen = numberElements(await this.call<UiElement[]>({ op: "sim.ui", scope: this.deps.scope }, signal, 120_000));
    return this.screen;
  }

  async simScreenshot(saveAs?: string, region?: readonly number[], signal?: AbortSignal): Promise<AgentToolResult<Details>> {
    const boot = await this.booted(signal);
    const save = this.saveAs(saveAs);
    const img = await this.call<ImageResult>({ op: "sim.screenshot", scope: this.deps.scope, ...(save ? { saveAs: save } : {}), ...(region ? { region: region as [number, number, number, number] } : {}) }, signal, 120_000);
    this.last = "simulator";
    const points = this.screen ?? (await this.readScreen(signal).catch(() => null));
    const scale = points?.width ? ` 1 image px = ${(points.width / img.width).toFixed(3)} points; taps use points.` : "";
    const what = region ? `A closer look at [${region.join(", ")}] of the simulator screen` : `The simulator screen, ${img.width}×${img.height} px${points?.width ? ` (${points.width}×${points.height} points)` : ""}.${scale}`;
    return this.image(`${boot}${what}`, img);
  }

  async browserScreenshot(fullPage: boolean, saveAs?: string, region?: readonly number[]): Promise<AgentToolResult<Details>> {
    const save = this.saveAs(saveAs);
    const r = await this.session().command<ImageResult & { url: string; title: string }>({ cmd: "screenshot", ...(fullPage ? { fullPage: true } : {}), ...(save ? { saveAs: save } : {}), ...(region ? { region } : {}) });
    this.last = "browser";
    return this.image(`${region ? `A closer look at [${region.join(", ")}] of ` : ""}${r.title || "(untitled)"} — ${r.url}`, r);
  }

  tools(): AgentTool<any, Details>[] {
    const tools: AgentTool<any, Details>[] = [];
    if (this.deps.needs.includes("simulator")) tools.push(...this.simTools());
    if (this.deps.needs.includes("browser")) tools.push(...this.browserTools());
    if (tools.length) tools.push(tool("look_at", "Look closely at part of the screen you last captured: a fresh capture of that region, enlarged. Use it for small icons and text before deciding. region is [x1, y1, x2, y2], each 0–1000 of the width and height.",
      Type.Object({ region: Type.Array(Type.Number({ minimum: 0, maximum: 1000 }), { minItems: 4, maxItems: 4 }) }),
      async (p, signal) => {
        if (this.last === "browser") return this.browserScreenshot(false, undefined, p.region);
        if (this.last === "simulator") return this.simScreenshot(undefined, p.region, signal);
        return text("Take a screenshot first (sim_screenshot or browser_screenshot).");
      }));
    // One device and one browser: their tools run one at a time.
    return tools.map((t) => ({ ...t, executionMode: "sequential" as const }));
  }

  private simTools(): AgentTool<any, Details>[] {
    const ios = this.deps.profile?.ios ?? {};
    const scope = this.deps.scope;
    return [
      tool("sim_build", `Build the iOS app for this workstation's simulator and install it (xcodebuild; Swift macros work). ${ios.scheme ? `Defaults: scheme ${ios.scheme}${ios.project ? `, ${ios.project}` : ""}${ios.workspace ? `, ${ios.workspace}` : ""}.` : "Find the scheme with `xcodebuild -list` first."} The first build of a project takes a few minutes.`,
        Type.Object({ scheme: Type.Optional(Type.String()), project: Type.Optional(Type.String()), workspace: Type.Optional(Type.String()), configuration: Type.Optional(Type.String()) }),
        async (p, signal) => {
          const scheme = p.scheme ?? ios.scheme;
          if (!scheme) return text("Which scheme? Run `xcodebuild -list` with ws_bash, then call sim_build with scheme.");
          const boot = await this.booted(signal);
          const project = p.project ?? (p.workspace ? undefined : ios.project);
          const workspace = p.workspace ?? (p.project ? undefined : ios.workspace);
          const r = await this.call<SimBuildResult>({ op: "sim.build", scope, scheme, ...(project ? { project } : {}), ...(workspace ? { workspace } : {}), ...(p.configuration ? { configuration: p.configuration } : {}), timeoutMs: BUILD_TIMEOUT_MS }, signal, BUILD_TIMEOUT_MS + 60_000);
          if (!r.ok) return text(`${boot}Build failed after ${Math.round(r.durationMs / 1000)} s:\n${r.errors.join("\n") || "(no error lines; run xcodebuild with ws_bash to see the full log)"}`);
          this.bundleId = r.bundleId;
          return text(`${boot}Built and installed ${r.app} (${r.bundleId}) in ${Math.round(r.durationMs / 1000)} s. Start it with sim_launch.`);
        }),
      tool("sim_launch", "Start (or restart) the app on the simulator. args are launch arguments, e.g. to skip a login in a test build.",
        Type.Object({ bundle_id: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })) }),
        async (p, signal) => {
          const boot = await this.booted(signal);
          const bundleId = p.bundle_id ?? this.bundleId;
          if (!bundleId) return text("Which app? Build it with sim_build first, or give bundle_id.");
          await this.call({ op: "sim.launch", scope, bundleId, ...(p.args ? { args: p.args } : {}) }, signal);
          this.screen = null;
          await this.settle();
          return text(`${boot}Started ${bundleId}. Read the screen with sim_ui or look with sim_screenshot.`);
        }),
      tool("sim_ui", "Read the current screen: every labelled or tappable element with a number, its text and where it is (points). Cheaper and more exact than a screenshot for finding what to tap.",
        Type.Object({}),
        async (_p, signal) => `${await this.booted(signal)}${formatScreen(await this.readScreen(signal))}`),
      tool("sim_tap", "Tap an element by its number from the last sim_ui, or a point (x, y in points). Read the screen again afterwards: it may have changed.",
        Type.Object({ element: Type.Optional(Type.Integer({ minimum: 1 })), x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })) }),
        async (p, signal) => {
          await this.booted(signal);
          let at: readonly [number, number];
          let what: string;
          if (p.element !== undefined) {
            const e = this.screen?.elements.find((x) => x.n === p.element);
            if (!e) return text(this.screen ? `There is no element ${p.element} on the last sim_ui; read the screen again.` : "Call sim_ui first to number the elements.");
            at = e.center;
            what = `[${e.n}] ${e.type}${e.label ? ` ${JSON.stringify(e.label.slice(0, 60))}` : ""}`;
          } else if (p.x !== undefined && p.y !== undefined) {
            at = [p.x, p.y];
            what = "the point";
          } else return text("Give element (a number from sim_ui) or x and y.");
          await this.call({ op: "sim.tap", scope, x: at[0], y: at[1] }, signal);
          this.screen = null;
          await this.settle();
          return text(`Tapped ${what} at ${at[0]},${at[1]}.`);
        }),
      tool("sim_type", "Type text into the focused field (tap the field first).",
        Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }),
        async (p, signal) => {
          await this.booted(signal);
          await this.call({ op: "sim.type", scope, text: p.text }, signal, 180_000);
          this.screen = null;
          return text(`Typed ${p.text.length} characters.`);
        }),
      tool("sim_swipe", "Swipe: direction (up scrolls the content up) or from/to points.",
        Type.Object({ direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])), from: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })), to: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })) }),
        async (p, signal) => {
          await this.booted(signal);
          const s = this.screen ?? (await this.readScreen(signal));
          const [w, h] = [s.width || 400, s.height || 870];
          const lines = { up: [[w / 2, h * 0.75], [w / 2, h * 0.25]], down: [[w / 2, h * 0.3], [w / 2, h * 0.8]], left: [[w * 0.85, h / 2], [w * 0.15, h / 2]], right: [[w * 0.15, h / 2], [w * 0.85, h / 2]] } as const;
          const [from, to] = p.from && p.to ? [p.from, p.to] : p.direction ? lines[p.direction as keyof typeof lines] : [null, null];
          if (!from || !to) return text("Give a direction, or from and to.");
          await this.call({ op: "sim.swipe", scope, from: [from[0]!, from[1]!], to: [to[0]!, to[1]!] }, signal);
          this.screen = null;
          await this.settle();
          return text(`Swiped from ${from.map(Math.round).join(",")} to ${to.map(Math.round).join(",")}.`);
        }),
      tool("sim_button", "Press a hardware button: home, lock, side-button, siri.",
        Type.Object({ button: Type.Union([Type.Literal("home"), Type.Literal("lock"), Type.Literal("side-button"), Type.Literal("siri")]) }),
        async (p, signal) => {
          await this.booted(signal);
          await this.call({ op: "sim.button", scope, button: p.button }, signal);
          this.screen = null;
          await this.settle();
          return text(`Pressed ${p.button}.`);
        }),
      tool("sim_screenshot", "See the simulator screen. save_as keeps it in the worktree as evidence (a .jpg path, e.g. docs/agentswarm/<task>/screenshots/01-home.jpg) for the acceptance report.",
        Type.Object({ save_as: Type.Optional(Type.String({ maxLength: 200 })) }),
        async (p, signal) => this.simScreenshot(p.save_as, undefined, signal)),
      tool("sim_logs", "The app's recent log lines (e.g. after a crash or a blank screen). process is the app's executable name.",
        Type.Object({ process: Type.Optional(Type.String({ maxLength: 80 })), seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 1800 })) }),
        async (p, signal) => {
          await this.booted(signal);
          const r = await this.call<{ output: string; truncated: boolean }>({ op: "sim.logs", scope, ...(p.process ? { process: p.process } : {}), ...(p.seconds ? { seconds: p.seconds } : {}) }, signal, 180_000);
          return `${r.truncated ? "(the newest lines)\n" : ""}${r.output.slice(-20_000) || "(no log lines)"}`;
        }),
    ];
  }

  private browserTools(): AgentTool<any, Details>[] {
    const b = () => this.session();
    const where = (r: { url: string; title: string }) => `${r.title || "(untitled)"} — ${r.url}`;
    const sites = this.deps.profile?.testSites?.length ? ` and ${this.deps.profile.testSites.join(", ")}` : "";
    return [
      tool("browser_open", `Open a page in this run's headless browser. The project's dev server on localhost is the usual target. Local network and tailnet addresses are refused; you may click and type only on localhost${sites}, elsewhere only read.`,
        Type.Object({ url: Type.String({ minLength: 1, maxLength: 2000 }) }),
        async (p) => {
          const r = await b().command<{ url: string; title: string; status: number | null }>({ cmd: "open", url: p.url });
          return `Opened ${where(r)} (HTTP ${r.status ?? "?"}). Read it with browser_snapshot.`;
        }),
      tool("browser_snapshot", "Read the page: its structure with element refs (e.g. [ref=e12]) to click or fill.",
        Type.Object({}),
        async () => {
          const r = await b().command<{ url: string; title: string; snapshot: string }>({ cmd: "snapshot" });
          return `${where(r)}\n${r.snapshot}`;
        }),
      tool("browser_click", "Click an element by its ref from the last browser_snapshot.",
        Type.Object({ ref: Type.String({ maxLength: 16 }) }),
        async (p) => `Clicked ${p.ref}. Now on ${where(await b().command({ cmd: "click", ref: p.ref }))}.`),
      tool("browser_fill", "Fill a text field by its ref (replaces what is there).",
        Type.Object({ ref: Type.String({ maxLength: 16 }), text: Type.String({ maxLength: 5000 }) }),
        async (p) => `Filled ${p.ref}. On ${where(await b().command({ cmd: "fill", ref: p.ref, text: p.text }))}.`),
      tool("browser_press", "Press a key on the focused element, e.g. Enter, Tab, Escape, Control+a.",
        Type.Object({ key: Type.String({ maxLength: 40 }) }),
        async (p) => `Pressed ${p.key}. On ${where(await b().command({ cmd: "press", key: p.key }))}.`),
      tool("browser_back", "Go back one page.",
        Type.Object({}),
        async () => `Back on ${where(await b().command({ cmd: "back" }))}.`),
      tool("browser_screenshot", "See the page (1280 px wide). full_page captures up to three screens' height. save_as keeps it as evidence (a .jpg path in the worktree).",
        Type.Object({ full_page: Type.Optional(Type.Boolean()), save_as: Type.Optional(Type.String({ maxLength: 200 })) }),
        async (p) => this.browserScreenshot(Boolean(p.full_page), p.save_as)),
      tool("browser_console", "Console errors, page errors and failed requests since the last call.",
        Type.Object({}),
        async () => {
          const r = await b().command<{ events: string[] }>({ cmd: "console" });
          return r.events.length ? r.events.join("\n") : "Nothing new.";
        }),
    ];
  }

  /** End of the run's execution: the simulator is shut down and erased, the browser closed. */
  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
    if (this.device) {
      this.device = null;
      await this.call({ op: "sim.shutdown", scope: this.deps.scope }, undefined, 300_000);
    }
  }
}

function tool<P extends TSchema>(name: string, description: string, parameters: P, run: (params: any, signal?: AbortSignal) => Promise<string | AgentToolResult<Details>>): AgentTool<P, Details> {
  return {
    name, label: name, description, parameters,
    execute: async (_id, params, signal) => {
      const out = await run(params, signal);
      return typeof out === "string" ? text(out) : out;
    },
  };
}
