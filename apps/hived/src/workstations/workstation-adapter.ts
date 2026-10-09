import type { AgentContext, CommandResult, WorkstationPort, WorktreeView } from "@hive/tools";
import type { Request } from "@hive/priv-helper";
import type { WorkstationService, WorkstationRow } from "./workstation-service.ts";
import { WorkstationError } from "./backend.ts";
import type { RepoService } from "../repos/repo-service.ts";
import { agentSlug } from "../repos/repo-service.ts";
import type { LeaseService } from "../leases/lease-service.ts";
import type { HeavySlots } from "../leases/heavy-slots.ts";
import type { GitRelay } from "../git-relay/relay.ts";
import type { AgentRow } from "../agents/agent-service.ts";

export interface AdapterDeps {
  readonly workstations: WorkstationService;
  readonly repos: RepoService;
  readonly leases: LeaseService;
  readonly heavy: HeavySlots;
  readonly relay: GitRelay;
  readonly findAgent: (agentId: string) => AgentRow | null;
  readonly agentName: (agentId: string) => string;
  readonly heavyWaitMs?: number;
  /** How long a write waits for another agent's lease before giving up. */
  readonly leaseWaitMs?: number;
  readonly onWaiting?: (agentId: string, reason: string | null) => void;
  /** Posts an agent-produced file into a channel. */
  readonly attach?: (ctx: AgentContext, channelId: string, filename: string, bytes: Uint8Array, caption: string) => { id: number };
}

type WorktreeRow = NonNullable<ReturnType<RepoService["activeWorktree"]>>;

/** hived's side of core.workstation: resolves where an agent works and enforces leases and slots. */
export class WorkstationAdapter implements WorkstationPort {
  constructor(private readonly deps: AdapterDeps) {}

  async whereAmI(ctx: AgentContext) {
    const ws = this.workstation(ctx);
    const wt = this.deps.repos.activeWorktree(ctx.agentId);
    return {
      workstation: `${ws.name} (${ws.osUser})`,
      worktree: wt && wt.workstationId === ws.id ? this.view(wt) : null,
      repos: this.deps.repos.list(ctx.orgId).map((r) => r.name),
    };
  }

  async checkout(ctx: AgentContext, repo: string, slug: string) {
    const ws = this.workstation(ctx);
    await this.claimWrite(ctx, ws);
    const agent = this.deps.findAgent(ctx.agentId);
    if (!agent) throw new Error("Agent not found");
    const res = await this.call(() =>
      this.deps.repos.checkout({ orgId: ctx.orgId, agent: { id: agent.id, name: agent.name }, workstation: { id: ws.id, osUser: ws.osUser }, repoName: repo, slug }),
    );
    const row = this.deps.repos.worktree(res.worktree.id)!;
    return { worktree: this.view(row), created: res.created, resumed: res.resumed };
  }

  list(ctx: AgentContext, path: string, depth: number) {
    return this.op<{ entries: string[]; truncated: boolean }>(ctx, (scope) => ({ op: "fs.list", scope, path, depth }));
  }

  read(ctx: AgentContext, path: string, offset: number, limit: number) {
    return this.op<{ content: string; fromLine: number; totalLines: number; truncated: boolean }>(ctx, (scope) => ({ op: "fs.read", scope, path, offset, limit }));
  }

  grep(ctx: AgentContext, pattern: string, path: string | undefined, glob: string | undefined) {
    return this.op<{ matches: string[]; truncated: boolean }>(ctx, (scope) => ({ op: "fs.grep", scope, pattern, ...(path ? { path } : {}), ...(glob ? { glob } : {}) }));
  }

  write(ctx: AgentContext, path: string, content: string) {
    return this.op<{ bytes: number }>(ctx, (scope) => ({ op: "fs.write", scope, path, content }), { write: true });
  }

  edit(ctx: AgentContext, path: string, oldText: string, newText: string, replaceAll: boolean) {
    return this.op<{ replacements: number }>(ctx, (scope) => ({ op: "fs.edit", scope, path, oldText, newText, replaceAll }), { write: true });
  }

  bash(ctx: AgentContext, command: string, timeoutMs: number, signal?: AbortSignal) {
    return this.op<CommandResult>(ctx, (scope) => ({ op: "exec", scope, command, timeoutMs }), { write: true, heavy: true, ...(signal ? { signal } : {}) });
  }

  async termCreate(ctx: AgentContext, name: string) {
    await this.op(ctx, (scope) => ({ op: "tmux.create", scope, name: this.termName(ctx, name) }), { write: true });
  }

  async termSend(ctx: AgentContext, name: string, keys: string, enter: boolean) {
    const ws = this.workstation(ctx);
    await this.claimWrite(ctx, ws);
    await this.call(() => this.deps.workstations.backend.call(ws.osUser, { op: "tmux.send", name: this.termName(ctx, name), keys, enter }));
  }

  async termRead(ctx: AgentContext, name: string, lines: number) {
    const ws = this.workstation(ctx);
    const res = await this.call(() => this.deps.workstations.backend.call<{ output: string }>(ws.osUser, { op: "tmux.read", name: this.termName(ctx, name), lines }));
    return res.output;
  }

  async termKill(ctx: AgentContext, name: string) {
    const ws = this.workstation(ctx);
    await this.claimWrite(ctx, ws);
    await this.call(() => this.deps.workstations.backend.call(ws.osUser, { op: "tmux.kill", name: this.termName(ctx, name) }));
  }

  gitStatus(ctx: AgentContext) {
    return this.op<{ status: string; recent: string }>(ctx, (scope) => ({ op: "git.status", scope }));
  }

  gitCommit(ctx: AgentContext, message: string) {
    return this.op<{ head: string }>(ctx, (scope) => ({ op: "git.commit", scope, message }), { write: true });
  }

  async gitPush(ctx: AgentContext) {
    const ws = this.workstation(ctx);
    const wt = this.worktree(ctx, ws);
    await this.claimWrite(ctx, ws);
    const outcome = await this.call(() => this.deps.relay.push({ agentId: ctx.agentId, worktreeId: wt.id, osUser: ws.osUser }));
    if (outcome.push.status !== "pushed") throw new Error(outcome.message);
    return outcome.message;
  }

  async pullRequest(ctx: AgentContext, title: string, body: string) {
    const ws = this.workstation(ctx);
    const wt = this.worktree(ctx, ws);
    return this.call(() => this.deps.relay.createPullRequest({ agentId: ctx.agentId, worktreeId: wt.id, title, body }));
  }

  async attachFile(ctx: AgentContext, channelId: string, path: string, caption: string) {
    if (!this.deps.attach) throw new Error("Attachments are not available");
    const res = await this.op<{ content: string; totalLines: number; truncated: boolean }>(ctx, (scope) => ({ op: "fs.read", scope, path, offset: 1, limit: 1_000_000 }));
    const { id } = this.deps.attach(ctx, channelId, path.split("/").pop() ?? "file.txt", new TextEncoder().encode(res.content), caption);
    return `Posted ${path} as message ${id}.`;
  }

  // -------------------------------------------------------------------------

  private async op<T>(ctx: AgentContext, build: (scope: string) => Request, opts: { write?: boolean; heavy?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const ws = this.workstation(ctx);
    const wt = this.worktree(ctx, ws);
    if (opts.write) await this.claimWrite(ctx, ws);
    this.deps.repos.touch(wt.id);
    const run = () => this.call(() => this.deps.workstations.backend.call<T>(ws.osUser, build(wt.scope)));
    if (!opts.heavy) return run();
    return this.deps.heavy.run(run, { waitMs: this.deps.heavyWaitMs ?? 120_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  private workstation(ctx: AgentContext): WorkstationRow {
    const ws = this.deps.workstations.forAgent(ctx.agentId);
    if (!ws || ws.orgId !== ctx.orgId) throw new Error("No workstation is assigned to you. Ask your owner to assign one in your agent settings.");
    return ws;
  }

  private worktree(ctx: AgentContext, ws: WorkstationRow): WorktreeRow {
    const wt = this.deps.repos.activeWorktree(ctx.agentId);
    if (!wt || wt.workstationId !== ws.id) throw new Error("No active worktree. Call ws_checkout(repo, slug) first.");
    return wt;
  }

  /** Waits (briefly, visibly) for the workstation's write lease instead of failing at once. */
  private async claimWrite(ctx: AgentContext, ws: WorkstationRow): Promise<void> {
    const deadline = Date.now() + (this.deps.leaseWaitMs ?? 60_000);
    let announced = false;
    try {
      for (;;) {
        // A stopped run must not take (and then strand) a lease or perform its write later.
        if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Run stopped");
        const res = this.deps.leases.acquire({ resourceId: ws.id, agentId: ctx.agentId, runId: ctx.runId });
        if (res.ok) return;
        const holder = this.deps.agentName(res.holder.holderAgentId);
        if (Date.now() >= deadline) {
          throw new Error(`Workstation ${ws.name} is being written by ${holder} until their turn ends. Read-only tools still work; try writing later.`);
        }
        if (!announced) {
          this.deps.onWaiting?.(ctx.agentId, `${ws.name} (held by ${holder})`);
          announced = true;
        }
        await abortableSleep(Math.min(1000, Math.max(10, deadline - Date.now())), ctx.signal);
      }
    } finally {
      if (announced) this.deps.onWaiting?.(ctx.agentId, null);
    }
  }

  private termName(ctx: AgentContext, name: string): string {
    const agent = this.deps.findAgent(ctx.agentId);
    return `${agentSlug(agent?.name ?? "agent", ctx.agentId)}-${name}`.slice(0, 64);
  }

  private view(wt: WorktreeRow): WorktreeView {
    const repo = wt.scope.split("/")[1] ?? "";
    return { repo, branch: wt.branch, scope: wt.scope };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WorkstationError) throw new Error(error.message);
      throw error;
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
