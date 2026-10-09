import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId, type CreateTask, type Task, type TaskDetail, type TaskEvent, type TaskStatus, type UpdateTask } from "@hive/core";
import { isGranted, type AgentContext, type TaskPort, type TaskView } from "@hive/tools";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import type { EventBus } from "../events/event-bus.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";
import type { ChatService } from "../chat/chat-service.ts";
import type { RepoService } from "../repos/repo-service.ts";
import type { GitRelay } from "../git-relay/relay.ts";
import type { GitHubPort } from "../git-relay/github.ts";
import type { WorkstationService } from "../workstations/workstation-service.ts";
import { canTransition, missingHandoffSections, taskSlug, type TaskActor } from "./task-rules.ts";

type TaskRow = typeof schema.tasks.$inferSelect;
type Actor = { kind: "user"; user: AuthUser } | { kind: "agent"; ctx: AgentContext };

const DIFF_PREVIEW = 6000;

export interface TaskServiceDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly chat: ChatService;
  readonly repos: RepoService;
  readonly relay: GitRelay;
  readonly workstations: WorkstationService;
  readonly github: GitHubPort;
  readonly log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  /** Stops an agent's current turn (budget exceeded). */
  readonly stopAgent: (agentId: string) => void;
  /** Records which task a run is working on (set by task_start) so its cost is charged there. */
  readonly markRunTask?: (runId: string, taskId: string) => void;
  /** Allocates the next task number for an org; numbers are never reused. */
  readonly nextTaskNumber?: (orgId: string) => number;
}

/** Tasks for people (HTTP) and agents (core.tasks), with role checks at execution time. */
export class TaskService implements TaskPort {
  constructor(private readonly deps: TaskServiceDeps) {}

  // --- people -------------------------------------------------------------------

  list(orgId: string): Task[] {
    const rows = this.deps.db.select().from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).orderBy(asc(schema.tasks.number)).all();
    return rows.map((r) => this.toTask(r));
  }

  detail(orgId: string, id: string): TaskDetail {
    const row = this.row(orgId, id);
    const events = this.deps.db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, id)).orderBy(asc(schema.taskEvents.id)).all();
    return { task: this.toTask(row), events: events.map((e) => this.toEvent(e)) };
  }

  create(actor: Actor, input: CreateTask, now = Date.now()): Task {
    const orgId = this.orgOf(actor);
    const ownerUserId = actor.kind === "user" ? actor.user.id : this.ownerOfAgent(actor.ctx.agentId);
    if (input.repositoryId) this.deps.repos.get(orgId, input.repositoryId);
    const deps = this.resolveDeps(orgId, input.dependsOn ?? []);
    for (const id of [input.assigneeAgentId, input.reviewerAgentId]) if (id) this.assertAgent(orgId, id);
    const byUser = actor.kind === "user";
    const assignee = byUser ? (input.assigneeAgentId ?? null) : null;
    const reviewer = byUser ? (input.reviewerAgentId ?? null) : null;
    const inserted = this.deps.db.transaction((tx) => {
      const number = this.deps.nextTaskNumber?.(orgId)
        ?? (tx.select({ n: sql<number>`coalesce(max(${schema.tasks.number}), 0)` }).from(schema.tasks).where(eq(schema.tasks.orgId, orgId)).get()?.n ?? 0) + 1;
      const id = newId("task");
      const created = tx.insert(schema.tasks).values({
        id, orgId, number, title: input.title.trim(), description: input.description, acceptance: input.acceptance ?? [],
        // People's tasks are approved on creation; agents' proposals wait in the backlog.
        status: byUser ? "todo" : "backlog", assigneeAgentId: assignee, reviewerAgentId: reviewer,
        createdByKind: actor.kind, createdById: actor.kind === "user" ? actor.user.id : actor.ctx.agentId, ownerUserId,
        repositoryId: input.repositoryId ?? null, branch: null, channelId: null, prUrl: null, prState: null,
        budgetUsd: input.budgetUsd ?? null, spentUsd: 0, approvedAt: byUser ? now : null, createdAt: now, updatedAt: now,
      }).returning().get();
      if (deps.length) tx.insert(schema.taskDependencies).values(deps.map((d) => ({ taskId: id, dependsOnTaskId: d }))).run();
      return created;
    });
    const creatorAgent = actor.kind === "agent" ? [actor.ctx.agentId] : [];
    const channel = this.deps.chat.channels.createTaskChannel(orgId, ownerUserId, `T-${inserted.number} ${inserted.title}`,
      [...creatorAgent, ...(assignee ? [assignee] : []), ...(reviewer ? [reviewer] : [])], now);
    const row = this.save(inserted, { channelId: channel.id }, false);
    this.event(row, actor, "created", { status: row.status }, now);
    this.publish(row);
    if (row.assigneeAgentId) this.notifyAssignee(row, "user");
    return this.toTask(row);
  }

  approve(user: AuthUser, id: string): Task {
    const row = this.row(user.orgId, id);
    if (row.status !== "backlog") throw conflict(`T-${row.number} is not waiting for approval`);
    const updated = this.save(row, { status: "todo", approvedAt: Date.now() });
    this.event(updated, { kind: "user", user }, "approved", {});
    this.deps.chat.postNotice(user.orgId, row.channelId!, `T-${row.number} approved by ${user.username}.`, this.leadsOf(updated), "user");
    return this.toTask(updated);
  }

  update(user: AuthUser, id: string, input: UpdateTask): Task {
    let row = this.row(user.orgId, id);
    const patch: Partial<TaskRow> = {};
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.acceptance !== undefined) patch.acceptance = input.acceptance;
    if (input.budgetUsd !== undefined) patch.budgetUsd = input.budgetUsd;
    if (input.repositoryId !== undefined) {
      if (input.repositoryId) this.deps.repos.get(user.orgId, input.repositoryId);
      patch.repositoryId = input.repositoryId;
    }
    if (input.status && input.status !== row.status) {
      if (!canTransition(row.status, input.status, "user")) throw badRequest(`Cannot move T-${row.number} from ${row.status} to ${input.status}`);
      if (input.status === "in_progress") this.assertDepsDone(row);
      patch.status = input.status;
      if (row.status === "backlog") patch.approvedAt = Date.now();
    }
    const reassigned = input.assigneeAgentId !== undefined && input.assigneeAgentId !== row.assigneeAgentId;
    const newReviewer = input.reviewerAgentId !== undefined && input.reviewerAgentId !== row.reviewerAgentId;
    for (const agentId of [input.assigneeAgentId, input.reviewerAgentId]) if (agentId) this.assertAgent(user.orgId, agentId);
    if (reassigned) patch.assigneeAgentId = input.assigneeAgentId ?? null;
    if (newReviewer) patch.reviewerAgentId = input.reviewerAgentId ?? null;
    if ((reassigned || newReviewer) && (patch.status ?? row.status) === "backlog") throw badRequest("Approve the task before assigning it");
    // Validate dependencies before writing anything, so a rejected request changes nothing.
    const deps = input.dependsOn ? this.resolveDeps(user.orgId, input.dependsOn) : null;
    if (deps) this.assertNoCycle(row, deps);
    row = this.save(row, patch);
    if (deps) this.setDeps(row, deps);
    if (patch.title) this.deps.chat.channels.rename(row.channelId!, `T-${row.number} ${row.title}`);
    this.event(row, { kind: "user", user }, "updated", { fields: Object.keys(patch) });
    // Worktrees are only removed after a merge; a manual "done" may still hold unpushed work.
    if (patch.status === "done") this.notifyDependents(row);
    if (reassigned && row.assigneeAgentId) this.notifyAssignee(row, "user");
    if (newReviewer && row.reviewerAgentId) this.deps.chat.channels.addAgents(row.channelId!, [row.reviewerAgentId]);
    return this.toTask(row);
  }

  remove(user: AuthUser, id: string): void {
    const row = this.row(user.orgId, id);
    if (!["backlog", "todo", "done"].includes(row.status)) throw conflict("Only tasks that are not in flight can be deleted");
    const waiting = this.deps.db.select({ n: schema.tasks.number }).from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
      .where(eq(schema.taskDependencies.dependsOnTaskId, id)).all();
    if (row.status !== "done" && waiting.length) throw conflict(`T-${waiting.map((w) => w.n).join(", T-")} depend on this task; remove those dependencies first`);
    this.deps.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
    if (row.channelId) this.deps.chat.channels.remove(row.channelId);
    this.deps.bus.publish(row.orgId, { type: "task.deleted", taskId: id });
  }

  // --- agents (TaskPort) ---------------------------------------------------------

  listFor(ctx: AgentContext, filter: { status?: TaskStatus; mine?: boolean }): TaskView[] {
    return this.list(ctx.orgId)
      .filter((t) => (!filter.status || t.status === filter.status) && (!filter.mine || t.assigneeAgentId === ctx.agentId || t.reviewerAgentId === ctx.agentId))
      .map((t) => this.view(t));
  }

  getFor(ctx: AgentContext, ref: string): { task: TaskView; history: string[] } {
    const row = this.byRef(ctx.orgId, ref);
    const detail = this.detail(ctx.orgId, row.id);
    return { task: this.view(detail.task), history: detail.events.map((e) => `${new Date(e.createdAt).toISOString().slice(0, 16)} ${e.actorName} ${e.kind}${e.data.note ? `: ${String(e.data.note).slice(0, 200)}` : ""}`) };
  }

  createFor(ctx: AgentContext, input: { title: string; description: string; acceptance: string[]; dependsOn: string[]; repo?: string }): TaskView {
    const repoId = input.repo ? this.repoByName(ctx.orgId, input.repo) : undefined;
    const dependsOn = input.dependsOn.map((r) => this.byRef(ctx.orgId, r).id);
    const task = this.create({ kind: "agent", ctx }, { title: input.title, description: input.description, acceptance: input.acceptance, dependsOn, ...(repoId ? { repositoryId: repoId } : {}) });
    return this.view(task);
  }

  assignFor(ctx: AgentContext, ref: string, agent: string, reviewer?: string): TaskView {
    this.requireLead(ctx);
    let row = this.byRef(ctx.orgId, ref);
    if (row.status === "backlog") throw new Error(`T-${row.number} is waiting for a person to approve it; ask them on the chat first.`);
    if (!["todo", "blocked", "in_progress"].includes(row.status)) throw new Error(`T-${row.number} is ${row.status}; it cannot be assigned now.`);
    const assignee = this.agentByName(ctx.orgId, agent);
    const rev = reviewer ? this.agentByName(ctx.orgId, reviewer) : null;
    row = this.save(row, { assigneeAgentId: assignee.id, ...(rev ? { reviewerAgentId: rev.id } : {}) });
    this.deps.chat.channels.addAgents(row.channelId!, [ctx.agentId, ...(rev ? [rev.id] : [])]);
    this.event(row, { kind: "agent", ctx }, "assigned", { assignee: assignee.name, reviewer: rev?.name ?? null });
    this.notifyAssignee(row, "agent");
    return this.view(this.toTask(row));
  }

  async startFor(ctx: AgentContext, ref: string): Promise<{ task: TaskView; branch: string; created: boolean }> {
    let row = this.byRef(ctx.orgId, ref);
    if (row.assigneeAgentId !== ctx.agentId) throw new Error(`T-${row.number} is not assigned to you.`);
    if (!canTransition(row.status, "in_progress", "assignee")) throw new Error(`T-${row.number} is ${row.status}; it cannot be started.`);
    this.assertNotOverBudget(row);
    this.assertDepsDone(row, (m) => new Error(m));
    const ws = this.deps.workstations.forAgent(ctx.agentId);
    if (!ws) throw new Error("No workstation is assigned to you. Ask your owner to assign one in your agent settings.");
    const repoId = row.repositoryId ?? this.onlyRepo(ctx.orgId);
    // Keep the branch the task started on, even if its title changed since.
    const slug = row.branch?.split("/")[2] ?? taskSlug(row.title);
    const res = await this.deps.repos.checkoutTask({ orgId: ctx.orgId, agentId: ctx.agentId, workstation: { id: ws.id, osUser: ws.osUser }, repoId, task: { id: row.id, number: row.number, slug } });
    this.deps.markRunTask?.(ctx.runId, row.id);
    row = this.save(row, { status: "in_progress", branch: res.branch, repositoryId: repoId });
    this.event(row, { kind: "agent", ctx }, "started", { branch: res.branch });
    return { task: this.view(this.toTask(row)), branch: res.branch, created: res.created };
  }

  updateFor(ctx: AgentContext, ref: string, status: TaskStatus | undefined, note: string | undefined): TaskView {
    let row = this.byRef(ctx.orgId, ref);
    const role = this.roleOf(ctx, row);
    if (!role) throw new Error(`Only the assignee or a lead can update T-${row.number}.`);
    if (status && status !== row.status) {
      if (!canTransition(row.status, status, role)) throw new Error(`As ${role} you cannot move T-${row.number} from ${row.status} to ${status}.`);
      if (row.status === "blocked") this.assertNotOverBudget(row);
      if (status === "in_progress") this.assertDepsDone(row, (m) => new Error(m));
      row = this.save(row, { status });
      if (status === "in_review" && row.reviewerAgentId && row.reviewerAgentId !== ctx.agentId) {
        this.deps.chat.postNotice(ctx.orgId, row.channelId!, `T-${row.number} is ready for review again${note ? ` (${note})` : ""}. @${this.agentName(row.reviewerAgentId)} please review it (pr_view, then task_review).`, [row.reviewerAgentId], "agent");
      }
    }
    this.event(row, { kind: "agent", ctx }, status ? `status:${status}` : "note", note ? { note } : {});
    return this.view(this.toTask(row));
  }

  commentFor(ctx: AgentContext, ref: string, body: string): void {
    const row = this.byRef(ctx.orgId, ref);
    if (!row.channelId || !this.deps.chat.channels.isAgentMember(row.channelId, ctx.agentId)) throw new Error(`You are not in T-${row.number}'s channel.`);
    this.deps.chat.send(ctx, { channelId: row.channelId, body });
  }

  async handoffFor(ctx: AgentContext, ref: string, to: string, notes: string): Promise<TaskView> {
    let row = this.byRef(ctx.orgId, ref);
    const role = this.roleOf(ctx, row);
    if (role !== "assignee" && role !== "lead") throw new Error(`Only the assignee or a lead can hand off T-${row.number}.`);
    if (row.status === "backlog" || row.status === "done") throw new Error(`T-${row.number} is ${row.status}; only active tasks can be handed off.`);
    const missing = missingHandoffSections(notes);
    if (missing.length) throw new Error(`Handoff notes are missing: ${missing.join(", ")}. Write each as a heading or "label:" line with content.`);
    const target = this.agentByName(ctx.orgId, to);
    if (target.id === row.assigneeAgentId) throw new Error(`${target.name} already owns T-${row.number}.`);
    let pushed = "not pushed (handed off by a lead)";
    if (role === "assignee") pushed = await this.pushWip(ctx, row);
    // The push awaited: a merge, budget block or reassignment may have landed meanwhile.
    row = this.row(ctx.orgId, row.id);
    if (row.status === "done") throw new Error(`T-${row.number} was completed while handing off; nothing to hand over.`);
    const from = row.assigneeAgentId;
    // A handoff changes the owner only; status (including a budget or dependency block) is kept.
    row = this.save(row, { assigneeAgentId: target.id });
    this.event(row, { kind: "agent", ctx }, "handoff", { from: from ? this.agentName(from) : null, to: target.name, pushed, note: notes });
    this.deps.chat.channels.addAgents(row.channelId!, [target.id]);
    this.deps.chat.postNotice(ctx.orgId, row.channelId!,
      `Handoff of T-${row.number} to @${target.name} (${pushed}). Call task_start(${row.number}) to continue on branch ${row.branch ?? "(not started)"}.\n\n${notes}`,
      [target.id], "agent");
    return this.view(this.toTask(row));
  }

  reviewFor(ctx: AgentContext, ref: string, decision: "approve" | "request_changes", notes: string): TaskView {
    let row = this.byRef(ctx.orgId, ref);
    if (row.reviewerAgentId !== ctx.agentId) throw new Error(`You are not T-${row.number}'s reviewer.`);
    if (row.status !== "in_review") throw new Error(`T-${row.number} is ${row.status}, not in review.`);
    this.event(row, { kind: "agent", ctx }, `review:${decision}`, { note: notes });
    if (decision === "approve") {
      this.deps.chat.postNotice(ctx.orgId, row.channelId!, `${this.agentName(ctx.agentId)} approved T-${row.number}. Ready for a person to merge: ${row.prUrl ?? "(no PR)"}`, [], "agent");
    } else {
      row = this.save(row, { status: "in_progress" });
      const assignee = row.assigneeAgentId;
      this.deps.chat.postNotice(ctx.orgId, row.channelId!, `${this.agentName(ctx.agentId)} requested changes on T-${row.number}${assignee ? ` @${this.agentName(assignee)}` : ""}:\n\n${notes}`, assignee ? [assignee] : [], "agent");
    }
    return this.view(this.toTask(row));
  }

  async prViewFor(ctx: AgentContext, ref: string): Promise<string> {
    const row = this.byRef(ctx.orgId, ref);
    if (this.roleOf(ctx, row) === null) throw new Error(`You are not working on T-${row.number}.`);
    if (!row.prUrl) throw new Error(`T-${row.number} has no pull request yet.`);
    if (!this.deps.github.view) throw new Error("PR viewing is not available");
    const pr = await this.deps.github.view(row.prUrl);
    const files = pr.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join("\n");
    const diff = pr.diff.length > DIFF_PREVIEW ? `${pr.diff.slice(0, DIFF_PREVIEW)}\n… [diff truncated, ${pr.diff.length - DIFF_PREVIEW} more chars]` : pr.diff;
    return `${pr.title} — ${pr.state} — checks: ${pr.checks}\n${row.prUrl}\n\nFiles:\n${files}\n\nDiff:\n${diff}`;
  }

  async prCommentFor(ctx: AgentContext, ref: string, body: string): Promise<void> {
    const row = this.byRef(ctx.orgId, ref);
    if (!row.prUrl) throw new Error(`T-${row.number} has no pull request yet.`);
    if (this.roleOf(ctx, row) === null && row.reviewerAgentId !== ctx.agentId) throw new Error(`You are not working on T-${row.number}.`);
    if (!this.deps.github.comment) throw new Error("PR comments are not available");
    await this.deps.github.comment(row.prUrl, `${body}\n\n— ${this.agentName(ctx.agentId)} (Hive agent)`);
    this.event(row, { kind: "agent", ctx }, "pr_comment", { note: body.slice(0, 500) });
  }

  // --- hooks --------------------------------------------------------------------

  /** A PR was opened from a task branch: move to review and wake the reviewer. */
  onPullRequest(input: { taskId: string | null; agentId: string; url: string }): void {
    if (!input.taskId) return;
    let row = this.deps.db.select().from(schema.tasks).where(eq(schema.tasks.id, input.taskId)).get();
    if (!row || row.prUrl === input.url) return;
    row = this.save(row, { prUrl: input.url, prState: "open", status: canTransition(row.status, "in_review", "system") ? "in_review" : row.status });
    this.event(row, { kind: "agent", agentId: input.agentId }, "pr_opened", { url: input.url });
    const reviewer = row.reviewerAgentId;
    this.deps.chat.postNotice(row.orgId, row.channelId!, `PR for T-${row.number}: ${input.url}${reviewer ? `\n@${this.agentName(reviewer)} please review it against the acceptance criteria (pr_view, then task_review).` : ""}`, reviewer ? [reviewer] : [], "agent");
  }

  /**
   * Charges a model call to the task the run is working on: the task it started with task_start,
   * otherwise the task channel it was woken from. A set budget, once exceeded, blocks the task.
   */
  chargeFromChannels(channelIds: readonly string[], agentId: string, costUsd: number, runTaskId: string | null = null): void {
    if (costUsd <= 0) return;
    const row = runTaskId
      ? this.deps.db.select().from(schema.tasks).where(eq(schema.tasks.id, runTaskId)).get()
      : channelIds.length ? this.deps.db.select().from(schema.tasks).where(inArray(schema.tasks.channelId, [...channelIds])).get() : undefined;
    if (!row || row.status === "done") return;
    const updated = this.save(row, { spentUsd: row.spentUsd + costUsd }, false);
    if (updated.budgetUsd !== null && updated.spentUsd > updated.budgetUsd && updated.status !== "blocked" && updated.status !== "done") {
      const blocked = this.save(updated, { status: "blocked" });
      this.event(blocked, { kind: "system" }, "budget_exceeded", { spentUsd: updated.spentUsd, budgetUsd: updated.budgetUsd });
      this.deps.chat.postNotice(row.orgId, row.channelId!, `T-${row.number} spent $${updated.spentUsd.toFixed(2)} of its $${updated.budgetUsd.toFixed(2)} budget and is blocked. Raise the budget or reassign it to continue.`, [], "user");
      this.deps.stopAgent(agentId);
    } else {
      this.publish(updated);
    }
  }

  private syncing = false;

  /** Polls open PRs (every couple of minutes) and moves tasks accordingly. Never runs twice at once. */
  async syncPullRequests(): Promise<number> {
    if (!this.deps.github.status || this.syncing) return 0;
    this.syncing = true;
    try {
      return await this.syncOnce();
    } finally {
      this.syncing = false;
    }
  }

  private async syncOnce(): Promise<number> {
    if (!this.deps.github.status) return 0;
    const open = this.deps.db.select().from(schema.tasks).where(and(inArray(schema.tasks.status, ["in_review", "in_progress", "blocked"]), sql`${schema.tasks.prUrl} is not null`)).all();
    let changed = 0;
    for (const row of open) {
      try {
        const st = await this.deps.github.status(row.prUrl!);
        const prState = st.state === "open" && st.checksFailed ? "checks_failed" : st.state;
        if (prState === row.prState) continue;
        changed++;
        if (st.state === "merged") {
          const done = this.save(row, { prState, status: "done" });
          this.event(done, { kind: "system" }, "merged", {});
          this.deps.chat.postNotice(row.orgId, row.channelId!, `T-${row.number} merged. Done.`, [], "user");
          void this.cleanup(done);
          this.notifyDependents(done);
        } else if (st.state === "closed") {
          const back = this.save(row, { prState, status: canTransition(row.status, "in_progress", "system") ? "in_progress" : row.status, prUrl: null });
          this.event(back, { kind: "system" }, "pr_closed", {});
          const a = row.assigneeAgentId;
          this.deps.chat.postNotice(row.orgId, row.channelId!, `The PR for T-${row.number} was closed without merging.${a ? ` @${this.agentName(a)} check the channel for why before continuing.` : ""}`, a ? [a] : [], "user");
        } else {
          this.save(row, { prState });
          if (prState === "checks_failed" && row.assigneeAgentId) {
            this.deps.chat.postNotice(row.orgId, row.channelId!, `Checks failed on T-${row.number}'s PR. @${this.agentName(row.assigneeAgentId)} please look.`, [row.assigneeAgentId], "user");
          }
        }
      } catch (error) {
        this.deps.log("warn", "PR status check failed", { task: row.id, error: String(error) });
      }
    }
    return changed;
  }

  // --- internals ------------------------------------------------------------------

  private async pushWip(ctx: AgentContext, row: TaskRow): Promise<string> {
    const wt = this.deps.repos.taskWorktrees(row.id).find((w) => w.agentId === ctx.agentId);
    if (!wt) return "nothing to push (no worktree)";
    try {
      await this.deps.workstations.backend.call(wt.osUser, { op: "git.commit", scope: wt.scope, message: `WIP: handoff of T-${row.number}` });
    } catch {
      // Nothing to commit is fine.
    }
    const outcome = await this.deps.relay.push({ agentId: ctx.agentId, worktreeId: wt.id, osUser: wt.osUser });
    if (outcome.push.status === "pushed") return `WIP pushed to ${row.branch}`;
    if (/Nothing new/i.test(outcome.push.reason ?? "")) return "nothing new to push";
    // Never hand over work that only exists on this workstation.
    throw new Error(`Handoff stopped: your WIP could not be pushed (${outcome.push.reason ?? outcome.push.status}). Fix that, then hand off again.`);
  }

  private async cleanup(row: TaskRow): Promise<void> {
    for (const wt of this.deps.repos.taskWorktrees(row.id)) {
      try {
        await this.deps.repos.removeWorktree(wt.id, wt.osUser);
      } catch (error) {
        this.deps.log("warn", "task worktree cleanup failed", { task: row.id, error: String(error) });
      }
    }
  }

  /** A finished task may unblock others: wake their assignees once all their dependencies are done. */
  private notifyDependents(done: TaskRow): void {
    const dependents = this.deps.db.select({ t: schema.tasks }).from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
      .where(eq(schema.taskDependencies.dependsOnTaskId, done.id)).all().map((r) => r.t);
    for (const t of dependents) {
      if (!t.assigneeAgentId || !["todo", "blocked"].includes(t.status)) continue;
      try {
        this.assertDepsDone(t);
      } catch {
        continue;
      }
      this.deps.chat.postNotice(t.orgId, t.channelId!, `T-${done.number} is done, so T-${t.number} is unblocked. @${this.agentName(t.assigneeAgentId)} you are assigned T-${t.number}: ${t.title}. Call task_start(${t.number}) to begin.`, [t.assigneeAgentId], "user");
    }
  }

  private notifyAssignee(row: TaskRow, origin: "user" | "agent"): void {
    const a = row.assigneeAgentId;
    if (!a) return;
    this.deps.chat.channels.addAgents(row.channelId!, [a]);
    const acceptance = row.acceptance.length ? `\nAcceptance criteria:\n${row.acceptance.map((c) => `- ${c}`).join("\n")}` : "";
    this.deps.chat.postNotice(row.orgId, row.channelId!,
      `@${this.agentName(a)} you are assigned T-${row.number}: ${row.title}.${row.reviewerAgentId ? ` Reviewer: ${this.agentName(row.reviewerAgentId)}.` : ""}\n${row.description}${acceptance}\n\nCall task_start(${row.number}) to begin.`,
      [a], origin);
  }

  /** A task over its budget stays blocked until a person raises the budget or unblocks it. */
  private assertNotOverBudget(row: TaskRow): void {
    if (row.budgetUsd !== null && row.spentUsd > row.budgetUsd) {
      throw new Error(`T-${row.number} is over its $${row.budgetUsd.toFixed(2)} budget; only a person can unblock it.`);
    }
  }

  private roleOf(ctx: AgentContext, row: TaskRow): TaskActor | null {
    if (row.assigneeAgentId === ctx.agentId) return "assignee";
    if (isGranted(ctx.currentGrants(), "core.tasks", "task_assign")) return "lead";
    if (row.reviewerAgentId === ctx.agentId) return "reviewer";
    return null;
  }

  private requireLead(ctx: AgentContext): void {
    if (!isGranted(ctx.currentGrants(), "core.tasks", "task_assign")) throw new Error("Only a lead can assign tasks.");
  }

  private leadsOf(row: TaskRow): string[] {
    return row.createdByKind === "agent" ? [row.createdById] : [];
  }

  private assertDepsDone(row: TaskRow, makeError: (m: string) => Error = (m) => conflict(m)): void {
    const open = this.deps.db.select({ number: schema.tasks.number, status: schema.tasks.status }).from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.dependsOnTaskId))
      .where(eq(schema.taskDependencies.taskId, row.id)).all().filter((d) => d.status !== "done");
    if (open.length) throw makeError(`T-${row.number} is waiting on ${open.map((d) => `T-${d.number} (${d.status})`).join(", ")}.`);
  }

  private resolveDeps(orgId: string, ids: readonly string[]): string[] {
    return [...new Set(ids)].map((id) => this.row(orgId, id).id);
  }

  private assertNoCycle(row: TaskRow, deps: readonly string[]): void {
    if (deps.includes(row.id)) throw badRequest("A task cannot depend on itself");
    for (const d of deps) if (this.reaches(d, row.id)) throw badRequest("That dependency would create a cycle");
  }

  private setDeps(row: TaskRow, deps: string[]): void {
    this.assertNoCycle(row, deps);
    this.deps.db.transaction((tx) => {
      tx.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, row.id)).run();
      if (deps.length) tx.insert(schema.taskDependencies).values(deps.map((d) => ({ taskId: row.id, dependsOnTaskId: d }))).run();
    });
  }

  private reaches(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const next = this.deps.db.select({ d: schema.taskDependencies.dependsOnTaskId }).from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, from)).all();
    return next.some((n) => this.reaches(n.d, target, seen));
  }

  private save(row: TaskRow, patch: Partial<TaskRow>, publish = true): TaskRow {
    const updated = this.deps.db.update(schema.tasks).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.tasks.id, row.id)).returning().get()!;
    if (publish) this.publish(updated);
    return updated;
  }

  private publish(row: TaskRow): void {
    this.deps.bus.publish(row.orgId, { type: "task.updated", task: this.toTask(row) });
  }

  private event(row: TaskRow, actor: Actor | { kind: "system" } | { kind: "agent"; agentId: string }, kind: string, data: Record<string, unknown>, now = Date.now()): void {
    const actorKind = actor.kind;
    const actorId = actor.kind === "user" ? actor.user.id : actor.kind === "agent" ? ("ctx" in actor ? actor.ctx.agentId : actor.agentId) : "system";
    this.deps.db.insert(schema.taskEvents).values({ taskId: row.id, actorKind, actorId, kind, data, createdAt: now }).run();
  }

  private row(orgId: string, id: string): TaskRow {
    const row = this.deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, id), eq(schema.tasks.orgId, orgId))).get();
    if (!row) throw notFound("Task");
    return row;
  }

  /** "T-12", "t12", "12" or a task id. */
  private byRef(orgId: string, ref: string): TaskRow {
    const n = /^t-?(\d+)$/i.exec(ref.trim())?.[1] ?? (/^\d+$/.test(ref.trim()) ? ref.trim() : null);
    const row = n
      ? this.deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.number, Number(n)))).get()
      : this.deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.id, ref))).get();
    if (!row) throw new Error(`No task ${ref}. Use task_list to see tasks.`);
    return row;
  }

  private orgOf(actor: Actor): string {
    return actor.kind === "user" ? actor.user.orgId : actor.ctx.orgId;
  }

  private ownerOfAgent(agentId: string): string {
    const owner = this.deps.db.select({ u: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.u;
    if (!owner) throw new Error("Agent not found");
    return owner;
  }

  private assertAgent(orgId: string, id: string): void {
    if (!this.deps.db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.orgId, orgId))).get()) throw badRequest("Unknown agent");
  }

  private agentByName(orgId: string, nameOrId: string): { id: string; name: string } {
    const all = this.deps.db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.orgId, orgId)).all();
    const hit = all.find((a) => a.id === nameOrId) ?? all.find((a) => a.name.toLowerCase() === nameOrId.replace(/^@/, "").trim().toLowerCase());
    if (!hit) throw new Error(`No agent named ${nameOrId}. Use agent_directory to see colleagues.`);
    return hit;
  }

  private agentName(id: string): string {
    return this.deps.db.select({ n: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, id)).get()?.n ?? "agent";
  }

  private repoByName(orgId: string, name: string): string {
    const repo = this.deps.repos.byName(orgId, name);
    if (!repo) throw new Error(`No repository named ${name}.`);
    return repo.id;
  }

  private onlyRepo(orgId: string): string {
    const repos = this.deps.repos.list(orgId);
    if (repos.length !== 1) throw new Error("This task has no repository; ask a person to set one on the task.");
    return repos[0]!.id;
  }

  toTask(row: TaskRow): Task {
    const dependsOn = this.deps.db.select({ d: schema.taskDependencies.dependsOnTaskId }).from(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, row.id)).all().map((d) => d.d);
    const creatorName = row.createdByKind === "agent" ? this.agentName(row.createdById)
      : (this.deps.db.select({ n: schema.users.username }).from(schema.users).where(eq(schema.users.id, row.createdById)).get()?.n ?? "user");
    return {
      id: row.id, number: row.number, title: row.title, description: row.description, acceptance: row.acceptance, status: row.status,
      assigneeAgentId: row.assigneeAgentId, reviewerAgentId: row.reviewerAgentId,
      createdBy: { kind: row.createdByKind, id: row.createdById, name: creatorName },
      repositoryId: row.repositoryId, branch: row.branch, channelId: row.channelId, prUrl: row.prUrl, prState: row.prState,
      budgetUsd: row.budgetUsd, spentUsd: Math.round(row.spentUsd * 10000) / 10000, dependsOn, approved: row.approvedAt !== null,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  private view(t: Task): TaskView {
    const depNumbers = t.dependsOn.length
      ? this.deps.db.select({ n: schema.tasks.number }).from(schema.tasks).where(inArray(schema.tasks.id, t.dependsOn)).all().map((d) => `T-${d.n}`)
      : [];
    return {
      ref: `T-${t.number}`, title: t.title, status: t.status, description: t.description, acceptance: t.acceptance,
      assignee: t.assigneeAgentId ? this.agentName(t.assigneeAgentId) : null, reviewer: t.reviewerAgentId ? this.agentName(t.reviewerAgentId) : null,
      dependsOn: depNumbers, branch: t.branch, prUrl: t.prUrl, channelId: t.channelId, approved: t.approved, spentUsd: t.spentUsd,
    };
  }

  private toEvent(e: typeof schema.taskEvents.$inferSelect): TaskEvent {
    const actorName = e.actorKind === "agent" ? this.agentName(e.actorId)
      : e.actorKind === "user" ? (this.deps.db.select({ n: schema.users.username }).from(schema.users).where(eq(schema.users.id, e.actorId)).get()?.n ?? "user") : "system";
    return { id: e.id, taskId: e.taskId, actorKind: e.actorKind, actorName, kind: e.kind, data: e.data, createdAt: e.createdAt };
  }

  lastEventAt(taskId: string): number | null {
    return this.deps.db.select({ t: schema.taskEvents.createdAt }).from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)).orderBy(desc(schema.taskEvents.id)).limit(1).get()?.t ?? null;
  }
}
