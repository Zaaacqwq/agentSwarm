import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { MacBuildResult } from "@agentswarm/ws-exec";
import type { ProjectProfile } from "../db/schema.ts";
import type { RunRow } from "../agents/run-service.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { MAX_EVIDENCE } from "../eyes/eyes.ts";
import { saveScreen } from "../eyes/images.ts";
import type { DesktopService } from "./desktop-service.ts";
import { HelperError, type DesktopHelper } from "./helper.ts";
import { clipToSchema } from "../agents/clip.ts";
import { stageApp, type StageTools } from "./stage.ts";

/** You use the Mac: the agent waits this long at most before it is told to try later. */
const MAX_PAUSE_WAIT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 1_800_000;

export interface DesktopToolDeps {
  readonly service: DesktopService;
  readonly helper: DesktopHelper;
  readonly backend: WorkstationBackend;
  readonly workstation: string;
  readonly run: RunRow;
  readonly agent: string;
  readonly projectSlug: string;
  readonly profile: ProjectProfile | null;
  readonly appsDir: string;
  /** This run's screenshots for the dashboard: <data>/screens/<runId>. */
  readonly screensDir: string;
  /** The run's execution ends and waits for your answer (the approval). */
  waitForUser(): void;
  readonly stageTools?: StageTools;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Details = { screen?: string } | undefined;
const text = (t: string, terminate = false): AgentToolResult<Details> & { terminate?: boolean } => ({ content: [{ type: "text", text: t }], details: undefined, ...(terminate ? { terminate: true } : {}) });

interface LookReply {
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly ui: string;
  readonly inFront: boolean;
}

/**
 * A run's hands on the desktop (R9): it asks for a session, builds and opens its app, looks, and acts only on
 * that app. The helper enforces the session and the app; swarmd adds "look before you act" and your pauses.
 */
export class DesktopTools {
  private readonly deps: DesktopToolDeps;
  private evidence = 0;

  constructor(deps: DesktopToolDeps) {
    this.deps = deps;
  }

  tools(): AgentTool<any, Details>[] {
    const mac = this.deps.profile?.mac ?? {};
    const tools: AgentTool<any, Details>[] = [
      clipped(tool("desktop_request", "Ask the person for a session on this Mac's desktop, to test the app this run builds. Say what you will test and for how long (minutes, default 15, at most 30). Your turn ends; you continue when they decide. Ask once, when you are ready to test.",
        Type.Object({ purpose: Type.String({ minLength: 5, maxLength: 300 }), minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }),
        async (p) => this.request(p.purpose, p.minutes))),
      tool("desktop_open", `Build this worktree's macOS app and open it on the desktop (in the App Sandbox: no access to the person's files${mac.network ? "" : ", no network"}). ${mac.scheme ? `Defaults: scheme ${mac.scheme}${mac.project ? `, ${mac.project}` : ""}${mac.workspace ? `, ${mac.workspace}` : ""}.` : "Find the scheme with `xcodebuild -list` first."} Opening again rebuilds and replaces it.`,
        Type.Object({ scheme: Type.Optional(Type.String({ maxLength: 100 })), project: Type.Optional(Type.String({ maxLength: 200 })), workspace: Type.Optional(Type.String({ maxLength: 200 })), configuration: Type.Optional(Type.String({ maxLength: 40 })) }),
        async (p, signal) => this.open(p, signal)),
      tool("desktop_look", "See the app under test: a screenshot of its windows only (grid lines every 100 px) and its interface as a numbered list. save_as keeps the picture in the worktree as evidence (a .jpg path, e.g. docs/agentswarm/<task>/screenshots/01-main.jpg).",
        Type.Object({ save_as: Type.Optional(Type.String({ maxLength: 300, pattern: "\\.jpg$" })) }),
        async (p, signal) => this.look(p.save_as, signal)),
      tool("desktop_click", `Click in the app under test: an element number from the last desktop_look (preferred), or x, y in its screenshot. At most 3 actions between two looks.`,
        Type.Object({ element: Type.Optional(Type.Integer({ minimum: 1 })), x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })), button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])), double: Type.Optional(Type.Boolean()) }),
        async (p, signal) => this.act(p.element !== undefined ? { cmd: "press", element: p.element } : { cmd: "click", x: p.x, y: p.y, button: p.button ?? "left", count: p.double ? 2 : 1 }, signal)),
      tool("desktop_type", "Type text into the app under test (it must be in front; click the field first). A newline presses Return.",
        Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }),
        async (p, signal) => this.act({ cmd: "type", text: p.text }, signal)),
      tool("desktop_key", "Press a key or shortcut in the app under test, e.g. return, escape, cmd+s, cmd+n. Shortcuts that switch apps or open launchers are refused.",
        Type.Object({ combo: Type.String({ minLength: 1, maxLength: 40 }) }),
        async (p, signal) => this.act({ cmd: "key", combo: p.combo }, signal)),
      tool("desktop_scroll", "Scroll in the app under test: dy > 0 scrolls down. x, y (screenshot coordinates) say where.",
        Type.Object({ dx: Type.Optional(Type.Integer()), dy: Type.Optional(Type.Integer()), x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })) }),
        async (p, signal) => this.act({ cmd: "scroll", dx: p.dx ?? 0, dy: p.dy ?? 0, ...(p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : {}) }, signal)),
      tool("desktop_focus", "Bring the app under test to the front (when another window covers it, or typing is refused).",
        Type.Object({}), async () => this.focus()),
      tool("desktop_release", "End your desktop session as soon as you are done: the app is closed and the person has their Mac back.",
        Type.Object({}), async () => {
          await this.deps.service.release(this.deps.run.id);
          return "Released. The app was closed.";
        }),
    ];
    // One desktop: its tools run one at a time.
    return tools.map((t) => ({ ...t, executionMode: "sequential" as const }));
  }

  private request(purpose: string, minutes?: number): AgentToolResult<Details> {
    const s = this.deps.service.request(this.deps.run, this.deps.agent, { purpose, ...(minutes ? { minutes } : {}) });
    if (s.status === "active") return text("Your desktop session is already approved: go on.");
    this.deps.waitForUser();
    const wait = s.status === "queued" ? "Another agent has the desktop; your request waits its turn, then goes to the person." : "The person has been asked.";
    return text(`${wait} Your turn ends; you continue when they decide.`, true);
  }

  private async open(p: { scheme?: string; project?: string; workspace?: string; configuration?: string }, signal?: AbortSignal): Promise<string> {
    this.deps.service.session(this.deps.run.id);
    const mac = this.deps.profile?.mac ?? {};
    const scheme = p.scheme ?? mac.scheme;
    if (!scheme) return "Say which scheme to build (find it with `xcodebuild -list`).";
    const project = p.project ?? (p.workspace ? undefined : mac.project);
    const workspace = p.workspace ?? (p.project ? undefined : mac.workspace);
    const built = await this.deps.backend.call<MacBuildResult>(this.deps.workstation, {
      op: "mac.build", scope: this.deps.run.worktreeScope, scheme, ...(project ? { project } : {}), ...(workspace ? { workspace } : {}), ...(p.configuration ? { configuration: p.configuration } : {}), timeoutMs: BUILD_TIMEOUT_MS,
    }, { ...(signal ? { signal } : {}), timeoutMs: BUILD_TIMEOUT_MS + 60_000 });
    if (!built.ok || !built.archive || !built.app) return `The build failed (${Math.round(built.durationMs / 1000)} s):\n${built.errors.join("\n") || "(no error lines; run xcodebuild yourself to see why)"}`;
    // The build can take long: the session may have ended meanwhile.
    this.deps.service.session(this.deps.run.id);
    // A fresh folder per opening: the one before it may still be in use by the app being replaced.
    const runDir = join(this.deps.appsDir, this.deps.run.id);
    const dir = join(runDir, String(Date.now()));
    let opened: { name: string; inFront: boolean };
    try {
      const path = await stageApp({ archive: Buffer.from(built.archive, "base64"), dir, app: built.app, projectSlug: this.deps.projectSlug, network: Boolean(mac.network), ...(this.deps.stageTools ? { tools: this.deps.stageTools } : {}) });
      // Like any input, opening waits while you use the Mac (it would take the focus from you).
      const result = await this.untilIdle((session) => this.deps.helper.call<{ name: string; inFront: boolean }>({ cmd: "open", session, path }, 60_000), signal);
      if (result.gaveUp) {
        rmSync(dir, { recursive: true, force: true });
        return "The person is still using the Mac, so the app was not opened. Wait, then call desktop_open again.";
      }
      opened = result.value;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    // The app it replaced has been closed: its copy goes.
    for (const old of readdirSync(runDir)) if (join(runDir, old) !== dir) rmSync(join(runDir, old), { recursive: true, force: true });
    this.deps.service.opened(this.deps.run.id, opened.name || built.app);
    return `Built in ${Math.round(built.durationMs / 1000)} s and opened ${opened.name || built.app}${opened.inFront ? "" : " (not in front yet: desktop_focus)"}. Look at it with desktop_look.`;
  }

  private async look(saveAs: string | undefined, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
    const { token } = this.deps.service.session(this.deps.run.id);
    if (saveAs !== undefined && this.evidence >= MAX_EVIDENCE) throw new Error(`At most ${MAX_EVIDENCE} evidence screenshots per run; pick the ones that matter`);
    const shot = await this.deps.helper.call<LookReply>({ cmd: "look", session: token }, 30_000);
    this.deps.service.looked(this.deps.run.id);
    const file = saveScreen(this.deps.screensDir, Buffer.from(shot.image, "base64"));
    let saved = "";
    if (saveAs !== undefined) {
      await this.deps.backend.call(this.deps.workstation, { op: "fs.write", scope: this.deps.run.worktreeScope, path: saveAs, content: shot.image, encoding: "base64" }, signal ? { signal } : {});
      this.evidence += 1;
      saved = ` Saved as evidence: ${saveAs}.`;
    }
    const front = shot.inFront ? "" : "\nThe app is not in front: bring it forward (desktop_focus) before typing.";
    return {
      content: [{ type: "text", text: `The app under test (${shot.width}×${shot.height}).${saved}${front}\n${shot.ui}` }, { type: "image", data: shot.image, mimeType: "image/jpeg" }],
      details: { screen: file },
    };
  }

  private async focus(): Promise<string> {
    const { token } = this.deps.service.session(this.deps.run.id);
    const r = await this.deps.helper.call<{ inFront: boolean }>({ cmd: "focus", session: token });
    return r.inFront ? "The app is in front." : "macOS did not bring it forward; try again.";
  }

  /** One action, counted against the looks; while you use the Mac it waits for you to stop, then goes on. */
  private async act(request: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (request.cmd === "click" && (request.x === undefined || request.y === undefined)) return "Give an element number, or both x and y.";
    this.deps.service.mayAct(this.deps.run.id);
    const done = await this.untilIdle((session) => this.deps.helper.call<{ inFront: boolean }>({ ...request, session }), signal);
    if (done.gaveUp) return "The person is still using the Mac. Wait, then try again; or release the desktop and report what you checked.";
    this.deps.service.acted(this.deps.run.id);
    const waited = done.waitedMs > 5_000 ? ` (waited ${Math.round(done.waitedMs / 1000)} s while the person used the Mac)` : "";
    return `Done${waited}.${done.value.inFront ? "" : " The app is no longer in front."} Look (desktop_look) to see what it did.`;
  }

  /** Runs a helper call with the session's token; while you use the Mac, waits (up to 10 minutes) and tries again. */
  private async untilIdle<T>(call: (token: string) => Promise<T>, signal?: AbortSignal): Promise<{ value: T; waitedMs: number; gaveUp?: false } | { value: never; waitedMs: number; gaveUp: true }> {
    const started = Date.now();
    for (;;) {
      const { token } = this.deps.service.session(this.deps.run.id);
      try {
        return { value: await call(token), waitedMs: Date.now() - started };
      } catch (error) {
        if (!(error instanceof HelperError) || error.code !== "paused") throw error;
        if (Date.now() - started > MAX_PAUSE_WAIT_MS) return { value: undefined as never, waitedMs: Date.now() - started, gaveUp: true };
        const until = error.pausedUntilMs ?? Date.now() + 5_000;
        await (this.deps.sleep ?? sleep)(Math.min(Math.max(1_000, until - Date.now() + 500), 15_000), signal);
        await this.deps.service.refresh();
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

/** An over-long text is cut to the schema rather than refused (a refused request costs the agent a turn). */
function clipped<P extends TSchema>(t: AgentTool<P, Details>): AgentTool<P, Details> {
  return { ...t, prepareArguments: clipToSchema(t.parameters) };
}

function tool<P extends TSchema>(name: string, description: string, parameters: P, run: (params: any, signal?: AbortSignal) => Promise<string | AgentToolResult<Details>> | AgentToolResult<Details>): AgentTool<P, Details> {
  return {
    name, label: name, description, parameters,
    execute: async (_id, params, signal) => {
      const out = await run(params, signal);
      return typeof out === "string" ? text(out) : out;
    },
  };
}
