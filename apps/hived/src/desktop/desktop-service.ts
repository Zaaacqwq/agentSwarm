import type { DesktopStatus } from "@hive/core";
import type { AgentContext, DesktopAction, DesktopOutcome, DesktopPort } from "@hive/tools";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { ScreenshotStore } from "../files/screenshot-store.ts";
import type { LeaseService } from "../leases/lease-service.ts";
import { HelperError, type DesktopHelper, type HelperStatus } from "./desktop-helper.ts";

export const DESKTOP_RESOURCE = "desktop:console";
const WATCH_MS = 5_000;

export interface DesktopServiceDeps {
  readonly helper: DesktopHelper;
  readonly leases: LeaseService;
  readonly approvals: ApprovalService;
  readonly screenshots: ScreenshotStore;
  readonly agentName: (agentId: string) => string;
  readonly onChange: () => void;
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface ScreenshotReply {
  image: string;
  width: number;
  height: number;
  display: number;
  frontmost?: HelperStatus["frontmost"];
}

/**
 * One agent at a time may drive the console desktop, and only while it holds both the desktop
 * lease (per run) and a live approval (per session). The helper is armed for exactly that window
 * and enforces the expiry and the off-limits apps itself as well.
 */
export class DesktopService implements DesktopPort {
  private watch: ReturnType<typeof setInterval> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  /** The armed session's token; arm/disarm for older sessions are ignored by the helper. */
  private session: { token: string; agentId: string } | null = null;
  /** Arm and disarm reach the helper in the order they were issued. */
  private helperQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DesktopServiceDeps) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.helperQueue.then(work, work);
    this.helperQueue = next.catch(() => undefined);
    return next;
  }

  async acquire(ctx: AgentContext, reason: string, minutes: number): Promise<string> {
    const status = await this.helperStatus();
    if (!status.screenRecording || !status.accessibility) throw new Error("The desktop helper lacks Screen Recording or Accessibility permission; ask a person to grant it.");
    // A Stop from the menu bar ends every live desktop approval; control needs a fresh one.
    if (status.stoppedByUser) await this.honourStop();
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    if (holder && holder.holderAgentId !== ctx.agentId) {
      throw new Error(`${this.deps.agentName(holder.holderAgentId)} is using the desktop until ${clock(holder.expiresAt)}. Try again later.`);
    }
    const approval = await this.deps.approvals.request(ctx, { kind: "desktop", scope: "console", question: reason, durationMs: minutes * 60_000 });
    if (approval.status !== "approved" || !approval.expiresAt) {
      const why = approval.status === "denied" ? `${approval.decidedBy ?? "A person"} declined` : approval.status === "expired" ? "no one answered in time" : `the request was ${approval.status}`;
      throw new Error(`Desktop control was not approved: ${why}.`);
    }
    const now = Date.now();
    const lease = this.deps.leases.acquire({ resourceId: DESKTOP_RESOURCE, agentId: ctx.agentId, runId: ctx.runId, ttlMs: approval.expiresAt - now, kind: "desktop" }, now);
    if (!lease.ok) throw new Error(`${this.deps.agentName(lease.holder.holderAgentId)} took the desktop first. Try again later.`);
    const token = crypto.randomUUID();
    try {
      await this.enqueue(() => this.deps.helper.call({ cmd: "arm", untilMs: approval.expiresAt, holder: this.deps.agentName(ctx.agentId), session: token }));
    } catch (error) {
      this.deps.leases.release(DESKTOP_RESOURCE, ctx.agentId);
      if (error instanceof HelperError && error.code === "denied") await this.honourStop();
      throw new Error(`Could not start the desktop session: ${message(error)}`);
    }
    this.session = { token, agentId: ctx.agentId };
    this.startWatching(approval.expiresAt, token);
    this.deps.onChange();
    return `Desktop control approved by ${approval.decidedBy ?? "a person"} until ${clock(approval.expiresAt)}. Look first with desktop_screenshot or desktop_ui, and call desktop_release when done.`;
  }

  /** The agent is done: end the session and its approval, so control needs asking again. */
  async release(ctx: AgentContext): Promise<string> {
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    const approval = this.deps.approvals.active(ctx.agentId, "desktop", "console");
    if (approval) this.deps.approvals.revoke(null, approval.id);
    if (!holder || holder.holderAgentId !== ctx.agentId) return approval ? "Ended your desktop approval." : "You were not holding the desktop.";
    await this.end(this.session?.agentId === ctx.agentId ? this.session.token : undefined);
    return "Released the desktop.";
  }

  /** Revokes all live desktop approvals after a person's Stop, then lets the helper arm again later. */
  private async honourStop(): Promise<void> {
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    for (const a of this.deps.approvals.activeOfKind("desktop")) this.deps.approvals.revoke(null, a.id);
    this.deps.log?.("desktop session stopped from the menu bar", { agentId: holder?.holderAgentId });
    await this.end();
    await this.deps.helper.call({ cmd: "ack_stop" }, 5_000).catch((error) => this.deps.log?.("desktop helper did not acknowledge the stop", { error: message(error) }));
  }

  async act(ctx: AgentContext, action: DesktopAction): Promise<DesktopOutcome> {
    await this.requireHolder(ctx);
    try {
      return await this.run(ctx, action);
    } catch (error) {
      if (error instanceof HelperError && error.code === "permission") throw new Error(`${error.message}; ask a person to grant it in System Settings.`);
      throw new Error(message(error));
    }
  }

  private async run(ctx: AgentContext, action: DesktopAction): Promise<DesktopOutcome> {
    if (action.cmd === "screenshot") {
      const shot = await this.deps.helper.call<ScreenshotReply>({ cmd: "screenshot", display: action.display ?? 0, grid: true }, 30_000);
      const saved = this.deps.screenshots.save({
        orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, source: "desktop", jpeg: Buffer.from(shot.image, "base64"), width: shot.width, height: shot.height,
      });
      return { text: `Display ${shot.display}: ${shot.width}×${shot.height} screenshot attached. ${front(shot.frontmost)}`, screenshot: { id: saved.id, data: shot.image, width: shot.width, height: shot.height } };
    }
    if (action.cmd === "ui") {
      const r = await this.deps.helper.call<{ text: string; app: string }>({ cmd: "ui", ...(action.app ? { app: action.app } : {}) }, 30_000);
      return { text: `${r.app}:\n${r.text || "(no accessible elements)"}` };
    }
    const r = await this.deps.helper.call<{ frontmost?: HelperStatus["frontmost"] }>({ ...action });
    const did = action.cmd === "click" ? `Clicked (${action.x}, ${action.y}) on display ${action.display ?? 0}.`
      : action.cmd === "type" ? `Typed ${action.text.length} characters.`
      : action.cmd === "key" ? `Pressed ${action.combo}.`
      : action.cmd === "press" ? `Pressed element [${action.element}].`
      : "Scrolled.";
    return { text: `${did} ${front(r.frontmost)}` };
  }

  /** The UI's live view (no grid), for people only; agents use act(). */
  async preview(display: number): Promise<{ jpeg: Buffer; width: number; height: number }> {
    const shot = await this.deps.helper.call<ScreenshotReply>({ cmd: "screenshot", display, grid: false, maxWidth: 1280 }, 30_000);
    return { jpeg: Buffer.from(shot.image, "base64"), width: shot.width, height: shot.height };
  }

  async status(): Promise<DesktopStatus> {
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    const approval = holder ? this.deps.approvals.active(holder.holderAgentId, "desktop", "console") : null;
    const holderView = holder && approval ? { agentId: holder.holderAgentId, agentName: this.deps.agentName(holder.holderAgentId), approvalId: approval.id, until: approval.expiresAt! } : null;
    if (!this.deps.helper.available()) {
      return { available: false, reason: "Hive Desktop is not installed (run scripts/install-desktop-helper.sh)", screenRecording: false, accessibility: false, displays: [], holder: holderView };
    }
    try {
      const s = await this.deps.helper.call<HelperStatus>({ cmd: "status" }, 5_000);
      return { available: true, screenRecording: s.screenRecording, accessibility: s.accessibility, displays: [...s.displays], holder: holderView };
    } catch (error) {
      return { available: false, reason: message(error), screenRecording: false, accessibility: false, displays: [], holder: holderView };
    }
  }

  async health(): Promise<{ available: boolean; reason?: string }> {
    const s = await this.status();
    if (!s.available) return { available: false, reason: s.reason ?? "desktop helper unavailable" };
    if (!s.screenRecording || !s.accessibility) return { available: false, reason: "Hive Desktop needs Screen Recording and Accessibility permission" };
    return { available: true };
  }

  /**
   * Ends the session: disarm the helper, return the lease. Safe to call repeatedly. With a token,
   * only that session is ended (a late timer or poll never ends a newer one).
   */
  async end(token?: string): Promise<void> {
    if (token && this.session?.token !== token) return;
    const ending = this.session;
    this.session = null;
    this.stopWatching();
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    if (holder) this.deps.leases.release(DESKTOP_RESOURCE, holder.holderAgentId);
    await this.enqueue(() => this.deps.helper.call({ cmd: "disarm", ...(ending ? { session: ending.token } : {}) }, 5_000))
      .catch((error) => this.deps.log?.("could not disarm the desktop helper", { error: message(error) }));
    this.deps.onChange();
  }

  /** Called whenever any lease changes; a desktop lease that ended (e.g. its run finished) disarms. */
  onLeaseChange(resourceId: string): void {
    if (resourceId === DESKTOP_RESOURCE && !this.deps.leases.current(DESKTOP_RESOURCE) && this.session) void this.end(this.session.token);
  }

  /** Called when a person revokes a desktop approval. */
  onApprovalEnded(agentId: string): void {
    if (this.session?.agentId === agentId) void this.end(this.session.token);
  }

  private async requireHolder(ctx: AgentContext): Promise<void> {
    const holder = this.deps.leases.current(DESKTOP_RESOURCE);
    const approval = this.deps.approvals.active(ctx.agentId, "desktop", "console");
    if (!holder || holder.holderAgentId !== ctx.agentId || !approval) {
      throw new Error("You do not hold the desktop. Call desktop_acquire(reason) first.");
    }
    if (holder.runId !== ctx.runId) {
      // A new turn within the approved window: carry the lease over to this run.
      this.deps.leases.acquire({ resourceId: DESKTOP_RESOURCE, agentId: ctx.agentId, runId: ctx.runId, ttlMs: approval.expiresAt! - Date.now(), kind: "desktop" });
    }
  }

  private async helperStatus(): Promise<HelperStatus> {
    if (!this.deps.helper.available()) throw new Error("Hive Desktop is not installed on this Mac; ask a person to run scripts/install-desktop-helper.sh.");
    try {
      return await this.deps.helper.call<HelperStatus>({ cmd: "status" }, 5_000);
    } catch (error) {
      throw new Error(`The desktop helper is not responding: ${message(error)}`);
    }
  }

  /** Follows the session: ends it at expiry, or as soon as the person stops it from the menu bar. */
  private startWatching(until: number, token: string): void {
    this.stopWatching();
    this.expiry = setTimeout(() => void this.end(token), Math.max(0, until - Date.now()));
    this.watch = setInterval(() => {
      void this.deps.helper.call<HelperStatus & { armed: { session?: string } | null }>({ cmd: "status" }, 5_000).then(async (s) => {
        if (this.session?.token !== token) return;
        if (s.stoppedByUser) return this.honourStop();
        if (!s.armed || s.armed.session !== token) await this.end(token);
      }).catch(() => undefined);
    }, WATCH_MS);
  }

  private stopWatching(): void {
    if (this.watch) clearInterval(this.watch);
    if (this.expiry) clearTimeout(this.expiry);
    this.watch = null;
    this.expiry = null;
  }
}

function front(f: HelperStatus["frontmost"] | undefined): string {
  if (!f?.app) return "";
  return `Front app: ${f.app}${f.title ? ` — ${f.title}` : ""}.`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
