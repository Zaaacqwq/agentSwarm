import { eq } from "drizzle-orm";
import type { BrowserRequest, BrowserResponse } from "@hive/priv-helper";
import type { AgentContext, BrowserAction, BrowserOutcome, BrowserPort } from "@hive/tools";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { ApprovalService } from "../approvals/approval-service.ts";
import type { ScreenshotStore } from "../files/screenshot-store.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { WorkstationService } from "../workstations/workstation-service.ts";

export interface BrowserAdapterDeps {
  readonly db: Db;
  readonly backend: WorkstationBackend;
  readonly workstations: WorkstationService;
  readonly approvals: ApprovalService;
  readonly screenshots: ScreenshotStore;
}

type Ok = Extract<BrowserResponse, { ok: true }>;

/**
 * Runs each agent's headless Chrome on its own workstation (as that workstation user) through
 * hive-exec. Writes are read-only by default: the approved hosts come from live approvals only.
 */
export class BrowserAdapter implements BrowserPort {
  /** One browser command at a time per agent (the daemon serves one page anyway). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BrowserAdapterDeps) {}

  run(ctx: AgentContext, action: BrowserAction): Promise<BrowserOutcome> {
    const previous = this.queues.get(ctx.agentId) ?? Promise.resolve();
    const next = previous.then(() => this.runNow(ctx, action), () => this.runNow(ctx, action));
    const settled = next.catch(() => undefined);
    this.queues.set(ctx.agentId, settled);
    void settled.then(() => {
      if (this.queues.get(ctx.agentId) === settled) this.queues.delete(ctx.agentId);
    });
    return next;
  }

  private async runNow(ctx: AgentContext, action: BrowserAction): Promise<BrowserOutcome> {
    const first = await this.call(ctx, action);
    if (!first.ok) {
      if (!first.needsApproval) throw new Error(first.error);
      const { host, reason } = first.needsApproval;
      const decision = await this.approve(ctx, host, reason);
      const retried = await this.call(ctx, action);
      if (!retried.ok) throw new Error(retried.error);
      return this.outcome(ctx, retried, decision);
    }
    if (first.blockedSite) {
      // The page's own submission was stopped. Ask now; the agent repeats the step once approved.
      const decision = await this.approve(ctx, first.blockedSite, "submitting a form");
      return this.outcome(ctx, first, `${decision} The blocked submission did not happen: open the form again and repeat it.`);
    }
    return this.outcome(ctx, first);
  }

  /** Stops the daemon and deletes the agent's browser profile (cookies, storage). */
  async reset(agentId: string): Promise<void> {
    const ws = this.deps.workstations.forAgent(agentId);
    if (ws) await this.deps.backend.call(ws.osUser, { op: "browser.reset", agent: agentId });
    this.deps.db.delete(schema.browserProfiles).where(eq(schema.browserProfiles.agentId, agentId)).run();
  }

  profile(agentId: string): (typeof schema.browserProfiles.$inferSelect) | null {
    return this.deps.db.select().from(schema.browserProfiles).where(eq(schema.browserProfiles.agentId, agentId)).get() ?? null;
  }

  private async call(ctx: AgentContext, command: BrowserAction): Promise<BrowserResponse> {
    const ws = this.deps.workstations.forAgent(ctx.agentId);
    if (!ws) throw new Error("You have no workstation, so you have no browser. Ask a person to bind one to you.");
    const request: BrowserRequest = { command, approvals: this.deps.approvals.approvedHosts(ctx.agentId) };
    const res = await this.deps.backend.call<BrowserResponse>(ws.osUser, { op: "browser", agent: ctx.agentId, request });
    const now = Date.now();
    this.deps.db.insert(schema.browserProfiles).values({ agentId: ctx.agentId, workstationId: ws.id, createdAt: now, lastUsedAt: now })
      .onConflictDoUpdate({ target: schema.browserProfiles.agentId, set: { lastUsedAt: now, workstationId: ws.id } }).run();
    return res;
  }

  private async approve(ctx: AgentContext, host: string, reason: string): Promise<string> {
    const row = await this.deps.approvals.request(ctx, { kind: "browser_site", scope: host, question: `${reason} on ${host}` });
    if (row.status !== "approved") {
      const why = row.status === "denied" ? `${row.decidedBy ?? "A person"} declined` : row.status === "expired" ? "no one answered in time" : `the request was ${row.status}`;
      throw new Error(`Not allowed: ${reason} on ${host} needs approval and ${why}. Continue read-only or ask what to do instead.`);
    }
    const minutes = Math.max(1, Math.round(((row.expiresAt ?? Date.now()) - Date.now()) / 60_000));
    return `${row.decidedBy ?? "A person"} approved writes on ${host} for ${minutes} min.`;
  }

  private outcome(ctx: AgentContext, res: Ok, approval?: string): BrowserOutcome {
    const base = {
      url: res.url, title: res.title,
      ...(res.text !== undefined ? { text: res.text } : {}),
      ...(res.blockedWrites?.length ? { blockedWrites: res.blockedWrites } : {}),
      ...(approval ? { approval } : {}),
    };
    if (!res.image) return base;
    const jpeg = Buffer.from(res.image, "base64");
    const shot = this.deps.screenshots.save({
      orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, source: "browser", jpeg, width: res.width ?? 1280, height: res.height ?? 800,
    });
    return { ...base, screenshot: { id: shot.id, data: res.image, width: shot.width, height: shot.height } };
  }
}
