import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { CreateMission, MissionMessageView, MissionView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { MissionKind, MissionStage } from "../db/schema.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { GitRunner } from "../github/git.ts";
import type { PullRequestState } from "../github/github-client.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { AgentService } from "../agents/agent-service.ts";
import { TERMINAL, TreeError, type TreeService } from "../agents/tree-service.ts";
import type { TreeCleanup } from "../agents/cleanup.ts";
import { WAIT_FOR_USER, type RunBinding, type RunHooks, type RunOpening, type RunRow, type RunService } from "../agents/run-service.ts";
import { pageWindow, type WebAccess } from "../web/web-access.ts";
import { FetchError } from "../web/web-fetch.ts";
import { MISSION_FINISH, changesBrief, intakeBrief, missionPromptSection, sentBackBrief, stageBrief, startBrief, type BriefContext } from "./briefs.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { ExecResult } from "@agentswarm/ws-exec";
import type { ProjectProfile } from "../db/schema.ts";
import { fileTicketTool, missionTools, suggestProfileTool, webTools, type WebToolOps } from "./mission-tools.ts";
import type { LessonService } from "../memory/lessons.ts";
import type { HandbookService } from "../memory/handbooks.ts";
import { proposeHandbookTool, recordLessonTool } from "../memory/tools.ts";
import type { Role } from "../db/schema.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { secretValues } from "../relay/relay.ts";
import { ENDED, GATES, STAGE_LABEL, WORKING, afterStageDone, canMove, firstStage, requiredDocs, stageTools, DOC_NAMES, type Actor, type Flow } from "./stages.ts";

/** R10: how QA sees a project's result. */
function screenOf(profile: ProjectProfile | null): BriefContext["screen"] {
  if (profile?.ios?.scheme || profile?.ios?.project || profile?.ios?.workspace) return "simulator";
  if (profile?.mac?.scheme || profile?.mac?.project || profile?.mac?.workspace) return "desktop";
  return "browser";
}

export type MissionRow = typeof schema.missions.$inferSelect;
type MessageRow = typeof schema.missionMessages.$inferSelect;
type Source = MessageRow["source"];

/** How a mission was started, beyond what you asked (R5). */
export interface CreateOptions {
  readonly origin?: MissionRow["origin"];
  /** A title instead of the idea's first line (a ticket: "FRI-12 the ticket's title"). */
  readonly title?: string;
  /** R10: how the ticket asked for it to be worked. */
  readonly options?: { readonly planFirst?: boolean; readonly marketing?: boolean; readonly researchOnly?: boolean };
}

const flowOf = (m: Pick<MissionRow, "kind" | "fast"> & { options?: MissionRow["options"] }): Flow => ({ kind: m.kind, fast: m.fast, plan: Boolean(m.options?.planFirst) });
/** Which kinds each kind of project can run: local projects never reach GitHub, so no pull requests. */
const KINDS_FOR: Record<"github" | "local", readonly MissionKind[]> = {
  github: ["change", "feature", "bug", "research", "marketing"],
  local: ["newproject", "quick", "research", "experiment"],
};
/** R10 kinds: they start working at once (no intake) and have the shorter flows. */
const R10_KINDS: ReadonlySet<MissionKind> = new Set(["change", "newproject", "quick"]);
/** Automatic checks failing this many times in a row: the lead stops and asks the person. */
export const MAX_CHECK_FAILURES = 3;
/** A lead that stops mid-stage is told to go on this many times before the person is asked. */
export const MAX_NUDGES = 2;
const CHECK_TIMEOUT_MS = 15 * 60_000;

export const DEFAULT_MISSION_BUDGET_USD = 3;

/** A board ticket's mission is titled "<KEY> <title>" (R7): its key, for commits and the pull request. */
export function ticketKey(m: Pick<MissionRow, "origin" | "title">): string | null {
  return m.origin === "ticket" ? /^([A-Z][A-Z0-9]{0,5}-\d+) /.exec(m.title)?.[1] ?? null : null;
}
const TREE_TOOLS = new Set(["spawn_agent", "wait_agents", "message_agent", "cancel_agent", "review_agent", "merge_agent"]);
/** Taken away in the read-only stages (intake, retro). */
const WRITE_TOOLS = new Set(["ws_write", "ws_edit", "git_commit", "git_push"]);

/** A researcher's share of the web: enough for one precise question, with time left to write the report. */
export const RESEARCH_LIMITS = { search: 12, fetch: 24, wrapUpShare: 0.6 } as const;
const RESEARCH_NOTE = `You have at most ${RESEARCH_LIMITS.search} searches and ${RESEARCH_LIMITS.fetch} page reads; stop when you can answer.`;

export interface MissionDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly runs: RunService;
  readonly tree: TreeService;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly git: GitRunner;
  readonly web: WebAccess;
  readonly cleanup: TreeCleanup;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** R8: lessons at the start, and what a retrospective records. */
  readonly memory?: { readonly lessons: LessonService; readonly handbooks: HandbookService };
  /** R10: runs the project's checks in the lead's worktree before a change is proposed. */
  readonly backend?: WorkstationBackend;
}

/** At most this many lessons and handbook proposals one mission adds (R8). */
const MAX_LESSONS = 3;
const MAX_PROPOSALS = 2;

const money = (usd: number) => `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
const slug = (text: string, max: number) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** Data from the web or other agents, fenced so it reads as information. */
function fenced(text: string): string {
  return `<<<untrusted\n${text.replaceAll(">>>", "> > >").replaceAll("<<<", "< < <")}\n>>>`;
}

/**
 * Missions: one idea through the pipeline. The lead's run carries every stage (one branch, one
 * worktree, one conversation); this service decides the stage, the lead's tools in it, and the gates.
 */
export class MissionService implements RunHooks {
  private readonly deps: MissionDeps;

  /** record_lesson calls per mission (a rewrite adds no row, but must not go on forever). */
  private readonly lessonCalls = new Map<string, number>();
  private openingSource: ((m: MissionRow) => Promise<RunOpening | null>) | null = null;
  private ticketFiler: ((m: MissionRow, agent: string, input: { title: string; description: string; kind: "feature" | "bug" | "research" }) => string) | null = null;

  /** R7: lets a ticket's lead put follow-ups in the backlog (file_ticket). */
  onFileTicket(filer: NonNullable<MissionService["ticketFiler"]>): void {
    this.ticketFiler = filer;
  }

  /** R7: where a mission's lead gets what came with the request (a ticket's pictures). */
  onOpening(source: (m: MissionRow) => Promise<RunOpening | null>): void {
    this.openingSource = source;
  }

  async opening(run: RunRow): Promise<RunOpening | null> {
    const m = this.missionOf(run);
    if (!m || run.id !== m.rootRunId || !this.openingSource) return null;
    return this.openingSource(m);
  }

  constructor(deps: MissionDeps) {
    this.deps = deps;
  }

  // ---- queries --------------------------------------------------------------------------

  list(limit = 100): MissionView[] {
    return this.deps.db.select().from(schema.missions).orderBy(desc(schema.missions.createdAt)).limit(Math.min(limit, 200)).all().map((m) => this.toView(m));
  }

  row(id: string): MissionRow {
    const row = this.deps.db.select().from(schema.missions).where(eq(schema.missions.id, id)).get();
    if (!row) throw notFound("No such mission");
    return row;
  }

  view(id: string): MissionView {
    return this.toView(this.row(id));
  }

  byThread(threadId: string): MissionRow | null {
    return this.deps.db.select().from(schema.missions).where(eq(schema.missions.discordThreadId, threadId)).get() ?? null;
  }

  messages(id: string, after = 0, limit = 500): MissionMessageView[] {
    this.row(id);
    return this.deps.db.select().from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, id), gt(schema.missionMessages.id, after)))
      .orderBy(asc(schema.missionMessages.id)).limit(Math.min(limit, 1000)).all().map(messageView);
  }

  /** The plan you are asked to approve now: the latest approval message (older buttons are stale). */
  latestApproval(id: string): number | null {
    const row = this.deps.db.select({ id: schema.missionMessages.id }).from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, id), eq(schema.missionMessages.kind, "approval")))
      .orderBy(desc(schema.missionMessages.id)).limit(1).get();
    return row?.id ?? null;
  }

  // ---- what the person does -------------------------------------------------------------

  create(actor: string, input: CreateMission, source: Source = "dashboard", now = Date.now(), opts: CreateOptions = {}): MissionView {
    const project = this.deps.projects.get(input.projectId);
    const kind = input.kind ?? (project.kind === "local" ? "experiment" : "feature");
    if (!KINDS_FOR[project.kind].includes(kind)) throw badRequest(`A ${kind} cannot run in ${project.kind === "local" ? "a local project" : "a GitHub project"}`);
    const lead = this.pickLead(project.id, input.agentId);
    const options = R10_KINDS.has(kind) ? { ...(opts.options ?? {}) } : {};
    const flow = { kind, fast: false, plan: Boolean(options.planFirst) };
    const stage = R10_KINDS.has(kind) ? firstStage(flow) : "intake";
    const idea = input.idea.trim();
    const title = (opts.title ?? (idea.split("\n")[0] ?? idea)).slice(0, 80).trim() || "Mission";
    const id = newId("msn");
    const docsPath = `docs/agentswarm/${slug(title, 32) || "mission"}-${randomBytes(3).toString("hex")}`;
    // Bugs take the short path: reproduce and plan, then the gate.
    const fast = kind === "bug" ? true : input.fast ?? false;
    // What earlier work learned that fits this request (R8).
    const advice = this.deps.runs.lessonsFor({ projectId: project.id }, "lead", `${title}\n${idea}`, 3, true);
    const ctx: BriefContext = { intent: idea, docs: docsPath, fast, defaultBranch: project.defaultBranch, kind, options, screen: screenOf(project.profile), product: Boolean(project.profile?.product) };
    const first = R10_KINDS.has(kind) ? startBrief(ctx, stage) : intakeBrief(ctx);
    const brief = [first, ...(advice ? ["", advice] : [])].join("\n");
    // The run cannot reach a hook before the mission row exists: it starts executing only after an await.
    const run = this.deps.runs.create(actor, lead.id, { title, brief, budgetUsd: input.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD }, now, id);
    this.deps.db.insert(schema.missions).values({
      id, projectId: project.id, title, intent: idea, stage, fast, leadAgentId: lead.id, rootRunId: run.id, treeId: run.treeId!,
      docsPath, pendingStage: null, stageSummary: null, retro: null, docs: [], discordThreadId: null, error: null,
      createdAt: now, updatedAt: now, endedAt: null, kind, origin: opts.origin ?? (source === "discord" ? "discord" : "dashboard"), options,
    }).run();
    audit(this.deps.db, actor, "mission.create", id, { projectId: project.id, fast, kind, source }, now);
    this.emit(id);
    this.post(id, "user", "text", idea, source, null, now);
    return this.view(id);
  }

  /** Your message in the thread: an answer, a steer, or (at the plan gate) a change request. */
  reply(actor: string, id: string, text: string, source: Source, discordMessageId: string | null = null): MissionView {
    const m = this.row(id);
    if (ENDED.has(m.stage)) throw conflict(`This mission is ${m.stage}`);
    this.post(id, "user", "text", text, source, discordMessageId);
    if (m.stage === "awaiting_approval") {
      this.post(id, "system", "text", "Taken as a change request: the plan goes back to planning. To approve it instead, use the Approve button.", "agentswarm");
      return this.requestChanges(actor, id, text, null);
    }
    this.deps.runs.message(actor, m.rootRunId, text);
    return this.view(id);
  }

  approve(actor: string, id: string): MissionView {
    const m = this.row(id);
    if (m.stage !== "awaiting_approval") throw conflict(`There is no plan waiting for approval (the mission is in ${STAGE_LABEL[m.stage].toLowerCase()})`);
    audit(this.deps.db, actor, "mission.approve", id);
    this.move(m, "building", "person");
    return this.view(id);
  }

  /** `source` null: the comment is already in the conversation (a reply at the gate). */
  requestChanges(actor: string, id: string, comment: string, source: Source | null = "dashboard"): MissionView {
    const m = this.row(id);
    if (m.stage !== "awaiting_approval") throw conflict("There is no plan waiting for approval");
    if (source) this.post(id, "user", "text", `Changes requested: ${comment}`, source);
    audit(this.deps.db, actor, "mission.request_changes", id);
    this.move(m, "planning", "person", { comment });
    return this.view(id);
  }

  /** R10: a pull request or a result back to the lead, with your comments (on lines of the change, or general). */
  sendBack(actor: string, id: string, comments: string, source: Source = "dashboard"): MissionView {
    const m = this.row(id);
    if (m.stage !== "awaiting_merge" && m.stage !== "review") throw conflict("There is nothing waiting for your review");
    if (!R10_KINDS.has(m.kind)) throw conflict("Send this one back by replying in its thread");
    this.post(id, "user", "text", `Sent back: ${comments}`, source);
    this.setOptions(id, {}, "sent back by the person");
    audit(this.deps.db, actor, "mission.send_back", id);
    this.move(m, "building", "person", { comment: comments });
    return this.view(id);
  }

  /** R10: a result you are done with (kept as a project by the ticket service, or simply finished). */
  finish(actor: string, id: string): MissionView {
    const m = this.row(id);
    if (m.stage !== "review") throw conflict("There is no result waiting for you");
    audit(this.deps.db, actor, "mission.finish", id);
    this.deps.db.update(schema.missions).set({ retro: this.retroFacts(m) }).where(eq(schema.missions.id, m.id)).run();
    this.move(m, "done", "person");
    return this.view(id);
  }

  cancel(actor: string, id: string): MissionView {
    const m = this.row(id);
    if (ENDED.has(m.stage)) throw conflict(`This mission is already ${m.stage}`);
    audit(this.deps.db, actor, "mission.cancel", id);
    this.move(m, "cancelled", "person");
    return this.view(id);
  }

  setBudget(actor: string, id: string, budgetUsd: number): MissionView {
    const m = this.row(id);
    const root = this.deps.tree.run(m.rootRunId);
    const spent = this.deps.tree.subtreeCost(root);
    if (budgetUsd < spent + 0.05) throw badRequest(`The mission has already spent $${spent.toFixed(2)}; the budget must be more than that`);
    this.deps.db.update(schema.runs).set({ budgetUsd }).where(eq(schema.runs.id, root.id)).run();
    audit(this.deps.db, actor, "mission.budget", id, { budgetUsd });
    this.post(id, "system", "text", `Budget set to $${budgetUsd.toFixed(2)} (spent so far: $${spent.toFixed(2)}).`, "agentswarm");
    this.emit(id);
    return this.view(id);
  }

  setThread(id: string, threadId: string): void {
    this.deps.db.update(schema.missions).set({ discordThreadId: threadId }).where(eq(schema.missions.id, id)).run();
    this.emit(id);
  }

  markDelivered(messageId: number, discordMessageId: string): void {
    this.deps.db.update(schema.missionMessages).set({ discordMessageId }).where(eq(schema.missionMessages.id, messageId)).run();
  }

  // ---- what GitHub does -----------------------------------------------------------------

  /** From the pull request watcher, for a mission's root; idempotent. */
  async pullRequestSettled(root: RunRow, state: PullRequestState): Promise<void> {
    const m = this.row(root.missionId!);
    if (state === "merged" && (m.stage === "verifying" || m.stage === "awaiting_merge")) {
      this.post(m.id, "system", "text", `The pull request was merged: ${root.prUrl}`, "agentswarm");
      // R10: a change that went smoothly ends here; its facts are kept. A retrospective only when something went wrong.
      if (m.kind === "change" && !m.options?.trouble?.length) {
        this.deps.db.update(schema.missions).set({ retro: this.retroFacts(m) }).where(eq(schema.missions.id, m.id)).run();
        this.move(m, "done", "github");
      } else {
        this.move(m, "retro", "github", { prUrl: root.prUrl ?? "" });
      }
    } else if (state === "closed" && !ENDED.has(m.stage)) {
      this.post(m.id, "system", "text", "The pull request was closed without merging, so the mission is cancelled.", "agentswarm");
      this.move(m, "cancelled", "github");
    } else if (ENDED.has(m.stage) && !root.cleanedAt) {
      await this.deps.cleanup.cleanWhenSettled(m.treeId);
    }
  }

  /** Ended missions whose cleanup never completed (timed out, interrupted by a restart, or a step failed). */
  async sweep(): Promise<void> {
    const ended = this.deps.db.select().from(schema.missions).where(inArray(schema.missions.stage, ["done", "cancelled"]))
      .orderBy(desc(schema.missions.updatedAt)).limit(50).all();
    for (const m of ended) {
      const root = this.deps.tree.run(m.rootRunId);
      if (root.cleanedAt) continue;
      // An open pull request is left alone; the watcher cleans up when it is merged or closed.
      if (root.prUrl && root.prState !== "merged" && root.prState !== "closed") continue;
      await this.deps.cleanup.clean(m.treeId).catch((e: Error) => this.deps.log("mission cleanup deferred", { missionId: m.id, error: e.message }));
    }
  }

  // ---- stage changes --------------------------------------------------------------------

  /** Moves the mission if `by` may, then does what entering the stage means. */
  private move(m: MissionRow, to: MissionStage, by: Actor, ctx: { comment?: string; prUrl?: string } = {}, now = Date.now()): boolean {
    if (!canMove(m.stage, to, by, flowOf(m))) {
      this.deps.log("mission move refused", { missionId: m.id, from: m.stage, to, by });
      return false;
    }
    this.deps.db.update(schema.missions).set({ stage: to, pendingStage: null, error: null, updatedAt: now, ...(ENDED.has(to) ? { endedAt: now } : {}) })
      .where(eq(schema.missions.id, m.id)).run();
    this.post(m.id, "system", "stage", `Stage: ${STAGE_LABEL[to]}`, "agentswarm", null, now);
    const brief = this.briefContext(m);
    const root = this.deps.tree.run(m.rootRunId);
    switch (to) {
      case "building":
        // R10: you sent it back with comments, or approved the plan of a change that started building.
        if (ctx.comment) this.deliver(m, sentBackBrief(brief, ctx.comment));
        else if (m.stage === "awaiting_approval" && m.kind === "change") this.deliver(m, `The person approved the plan in ${m.docsPath}/plan.md. ${stageBrief(to, brief)}`);
        else this.deliver(m, stageBrief(to, brief));
        break;
      case "research": case "discussion": case "verifying":
        this.deliver(m, stageBrief(to, brief));
        break;
      case "review":
        this.post(m.id, "system", "text", m.kind === "newproject"
          ? "The project is ready for you: keep it (it becomes a GitHub repository), send it back with comments, or drop it."
          : "The result is ready. Keep it as a new project, send it back with comments, or mark it done.", "agentswarm");
        break;
      case "planning":
        this.deliver(m, ctx.comment ? changesBrief(brief, ctx.comment) : stageBrief("planning", brief));
        break;
      case "awaiting_merge":
        this.post(m.id, "system", "text", `The pull request is ready: ${root.prUrl}\nMerge it on GitHub when you are happy with it (or close it to drop the mission). agentSwarm checks every few minutes.`, "agentswarm");
        break;
      case "retro":
        this.deliver(m, stageBrief("retro", brief, `The person merged the pull request ${ctx.prUrl ?? root.prUrl ?? ""}.\n\n${this.retroFacts(m)}\n`));
        break;
      case "done":
        void this.deps.cleanup.cleanWhenSettled(m.treeId).catch((e: Error) => this.deps.log("cleanup failed", { missionId: m.id, error: e.message }));
        break;
      case "cancelled": {
        const live = [root, ...this.deps.tree.descendants(root.id)].some((r) => !TERMINAL.has(r.status));
        if (live) this.deps.runs.cancel("system", root.id);
        // An open pull request is left to you; it is cleaned up when you merge or close it.
        if (!(root.prUrl && root.prState !== "merged" && root.prState !== "closed")) {
          void this.deps.cleanup.cleanWhenSettled(m.treeId).catch((e: Error) => this.deps.log("cleanup failed", { missionId: m.id, error: e.message }));
        }
        break;
      }
      default:
    }
    this.emit(m.id);
    return true;
  }

  private deliver(m: MissionRow, text: string): void {
    this.deps.runs.message("system", m.rootRunId, text, Date.now(), "agentswarm");
  }

  private briefContext(m: MissionRow): BriefContext {
    const project = this.deps.projects.get(m.projectId);
    const profile = project.profile ?? {};
    const ios = Boolean(profile.ios?.scheme) || /\bios\b|swiftui/i.test(profile.platform ?? "");
    return {
      intent: m.intent, docs: m.docsPath, fast: m.fast, defaultBranch: project.defaultBranch, kind: m.kind, product: Boolean(profile.product), ios,
      options: m.options ?? {}, screen: screenOf(project.profile),
    };
  }

  // ---- run hooks ------------------------------------------------------------------------

  prompt(run: RunRow): { section: string[]; finish: string } | null {
    const m = this.missionOf(run);
    if (!m || m.rootRunId !== run.id) return null;
    const key = ticketKey(m);
    const section = missionPromptSection(m.docsPath);
    return { section: key ? [...section, `- This mission is ticket ${key}: start every commit message with "${key}: ".`] : section, finish: MISSION_FINISH };
  }

  pullRequest(run: RunRow, title: string, body: string): { title: string; body: string } {
    const m = this.missionOf(run);
    const key = m && m.rootRunId === run.id ? ticketKey(m) : null;
    if (!key) return { title, body };
    return { title: title.startsWith(key) ? title : `${key} ${title}`, body: `${body.trim()}\n\nTicket ${key}` };
  }

  tools(run: RunRow, binding: RunBinding): ReturnType<RunHooks["tools"]> {
    const m = this.missionOf(run);
    if (!m) return null;
    // Sub-agents: researchers get the web while the mission researches.
    if (m.rootRunId !== run.id) return m.stage === "research" ? { add: webTools(this.webOps(run, binding, true), RESEARCH_NOTE) } : null;
    const t = stageTools(m.stage, m.kind);
    const keep = (name: string) => {
      if (name === "report") return false;
      if (name === "open_pull_request") return t.pullRequest;
      if (TREE_TOOLS.has(name)) return t.tree;
      if (t.workstation === "read") return !WRITE_TOOLS.has(name);
      return true;
    };
    const ops = {
      tell: (text: string) => void this.post(m.id, "lead", "text", text, "agentswarm"),
      ask: (question: string) => {
        this.post(m.id, "lead", "question", question, "agentswarm");
        binding.waitForUser();
      },
      stageDone: (summary: string) => this.finishStage(m.id, summary, false),
      requestApproval: (summary: string) => this.finishStage(m.id, summary, true),
    };
    const filer = this.ticketFiler;
    // Lessons at the retrospective, and at the last step of the flows that have none (R8).
    const last = m.stage === "retro" || (m.kind === "research" && m.stage === "discussion") || ((m.kind === "experiment" || m.kind === "quick") && m.stage === "building");
    const memory = last && this.deps.memory ? this.memoryTools(m, this.deps.agents.get(run.agentId).name, m.stage === "retro") : [];
    const file = m.origin === "ticket" && filer ? [fileTicketTool((input) => filer(m, this.deps.agents.get(run.agentId).name, input))] : [];
    // R10: a new project suggests the settings it will be registered with when you keep it.
    const profile = m.kind === "newproject" && m.stage === "building" ? [suggestProfileTool((p) => this.suggestProfile(m.id, p))] : [];
    return { keep, add: [...missionTools(ops, t), ...(t.web ? webTools(this.webOps(run, binding)) : []), ...file, ...memory, ...profile] };
  }

  private memoryTools(m: MissionRow, agentName: string, retro: boolean): AgentTool<any, undefined>[] {
    const memory = this.deps.memory!;
    // A name that would read as the person's ("you") never labels an agent's words.
    const agent = agentName.trim().toLowerCase() === "you" ? `agent ${agentName}` : agentName;
    // Unique per mission: a ticket's key, else the mission's own id.
    const source = ticketKey(m) ?? `${m.title.slice(0, 50)} (${m.id.slice(-6)})`;
    const tools: AgentTool<any, undefined>[] = [
      recordLessonTool(async (input) => {
        const calls = (this.lessonCalls.get(m.id) ?? 0) + 1;
        this.lessonCalls.set(m.id, calls);
        if (memory.lessons.countFor(m.id) >= MAX_LESSONS || calls > MAX_LESSONS * 2) return `You have recorded enough lessons for ${source}; put anything else in your retrospective.`;
        const forbidden = secretValues(await this.deps.projects.files(m.projectId));
        const role = input.role as Role | undefined;
        const r = memory.lessons.record({ scope: input.scope, title: input.title, text: input.text, ...(role ? { role } : {}) }, { agent, source, missionId: m.id, projectId: m.projectId, forbidden });
        return r.outcome === "recorded" ? `Recorded for this project: ${r.lesson.title}`
          : r.outcome === "suggested" ? `Suggested to the person (lessons for the whole team or a role need their approval): ${r.lesson.title}`
          : r.outcome === "improved" ? `Improved the existing lesson: ${r.lesson.title}`
          : `Already known (the person's or approved): ${r.lesson.title}`;
      }),
    ];
    if (retro) tools.push(proposeHandbookTool((input) => {
      const proposed = memory.handbooks.proposals().filter((p) => p.source === source).length;
      if (proposed >= MAX_PROPOSALS) return `You have proposed ${MAX_PROPOSALS} changes for ${source} already.`;
      memory.handbooks.propose(agent, source, input.role as Role, input.change, input.why);
      return "Proposed. The person will see it on the dashboard and decide.";
    }));
    return tools;
  }

  /** What the retrospective should know for sure, from the record rather than memory (R8). */
  private retroFacts(m: MissionRow, now = Date.now()): string {
    const root = this.deps.tree.run(m.rootRunId);
    const runs = [root, ...this.deps.tree.descendants(root.id)];
    const rejected = runs.filter((r) => r.kind === "review" && /^Changes requested/.test(r.report?.summary ?? "")).length;
    const failed = runs.filter((r) => r.status === "failed" && r.id !== root.id);
    const ids = runs.map((r) => r.id);
    const modelErrors = this.deps.db.select({ n: count() }).from(schema.runEvents)
      .where(and(eq(schema.runEvents.type, "error"), inArray(schema.runEvents.runId, ids), sql`json_extract(${schema.runEvents.data}, '$.message') like 'Model request failed%'`)).get()?.n ?? 0;
    const hours = (now - m.createdAt) / 3_600_000;
    // Sub-agents' titles and errors are their words: shown as data.
    const failures = failed.map((r) => `${r.title}: ${(r.error ?? "no reason").split("\n")[0]!.slice(0, 120)}`).join("\n");
    return [
      "Facts:",
      `- ${hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`} from the request to now, including the time waiting for the person; ${money(this.deps.tree.subtreeCost(root))} spent by ${runs.length} runs.`,
      `- Reviews that asked for changes: ${rejected}.`,
      `- Model requests that failed and were retried: ${modelErrors}.`,
      failed.length ? `- Sub-agents that failed (${failed.length}):\n${fenced(failures)}` : "- No sub-agent failed.",
    ].join("\n");
  }


  ended(run: RunRow): void {
    const m = this.missionOf(run);
    if (!m || m.rootRunId !== run.id) return;
    if (run.status === "waiting") return this.emit(m.id);
    if (run.status === "cancelled") {
      if (!ENDED.has(m.stage)) {
        this.post(m.id, "system", "text", "The lead was cancelled, so the mission is cancelled.", "agentswarm");
        this.move(m, "cancelled", "system");
      }
      return;
    }
    if (run.status === "failed") {
      if (ENDED.has(m.stage)) return;
      this.deps.db.update(schema.missions).set({ error: run.error, pendingStage: null, updatedAt: Date.now() }).where(eq(schema.missions.id, m.id)).run();
      this.setOptions(m.id, {}, `the lead failed: ${(run.error ?? "").slice(0, 120)}`);
      this.post(m.id, "system", "error", `The lead stopped: ${run.error ?? "unknown error"}\nReply here to let it continue.`, "agentswarm");
      return this.emit(m.id);
    }
    if (run.status !== "succeeded") return;
    if (m.pendingStage) {
      const to = m.pendingStage;
      if (!canMove(m.stage, to, "lead", flowOf(m))) {
        // The mission moved on meanwhile (you stopped it, or the pull request closed): drop the request.
        this.deps.db.update(schema.missions).set({ pendingStage: null }).where(eq(schema.missions.id, m.id)).run();
        return this.emit(m.id);
      }
      if (to === "done") this.deps.db.update(schema.missions).set({ retro: m.stageSummary }).where(eq(schema.missions.id, m.id)).run();
      if (m.options?.nudges) this.setOptions(m.id, { nudges: 0 });
      // A standing decision of the person: this project's bug fixes go ahead without asking each time.
      const auto = to === "awaiting_approval" && m.kind === "bug" && Boolean(this.deps.projects.get(m.projectId).profile?.autoApproveBugs);
      // No approval request (no button in Linear, no ping in Discord) for a plan that approves itself.
      this.post(m.id, "lead", to === "awaiting_approval" && !auto ? "approval" : "stage", m.stageSummary ?? "(no summary)", "agentswarm");
      this.move(this.row(m.id), to, "lead");
      if (auto) {
        audit(this.deps.db, "system", "mission.auto_approve", m.id, { reason: "project setting" });
        this.post(m.id, "system", "text", "Approved automatically: this project lets bug fixes go ahead without asking. The pull request still waits for you.", "agentswarm");
        this.move(this.row(m.id), "building", "person");
      }
    } else if (WORKING.has(m.stage) && R10_KINDS.has(m.kind) && (m.options?.nudges ?? 0) < MAX_NUDGES) {
      // R10: a lead that stops mid-stage is told to go on (as agent-swarm-ng does with its todo lists), a few times.
      this.setOptions(m.id, { nudges: (m.options?.nudges ?? 0) + 1 }, "the lead stopped mid-stage");
      this.deliver(m, `You stopped without finishing the ${STAGE_LABEL[m.stage].toLowerCase()} stage. Go on until it is done and call ${m.stage === "planning" ? "request_approval" : "stage_done"}; if you are stuck or need a decision, ask_user instead.`);
      this.emit(m.id);
    } else if (WORKING.has(m.stage)) {
      const summary = run.report?.summary ?? "";
      this.post(m.id, "lead", "text", `${summary}\n\n(The lead stopped without finishing this stage. Reply to tell it how to go on.)`.trim(), "agentswarm");
      this.emit(m.id);
    } else {
      this.emit(m.id);
    }
  }

  /** stage_done and request_approval: checks, then records where the mission goes when this execution ends. */
  private async finishStage(id: string, summary: string, approval: boolean): Promise<string> {
    const m = this.row(id);
    // A change the lead finds risky stops in building for a plan (R10).
    const planAgain = approval && m.kind === "change" && m.stage === "building";
    const next = approval ? (m.stage === "planning" || planAgain ? "awaiting_approval" : null) : afterStageDone(m.stage, flowOf(m));
    if (!next) throw new TreeError(approval ? "request_approval is only for the planning stage" : `The ${STAGE_LABEL[m.stage].toLowerCase()} stage does not end with stage_done`);
    const root = this.deps.tree.run(m.rootRunId);
    const live = this.deps.tree.descendants(root.id).filter((r) => !TERMINAL.has(r.status));
    if (live.length) throw new TreeError(`Sub-agents are still working (${live.map((r) => r.title).join(", ")}); wait for them first`);
    const found = await this.docsOnBranch(m, root.branch);
    const missing = (planAgain ? ["plan.md"] : requiredDocs(m.stage, m.kind)).filter((d) => !found.includes(d));
    if (missing.length) throw new TreeError(`Commit and git_push ${missing.map((d) => `${m.docsPath}/${d}`).join(", ")} first`);
    if ((m.stage === "verifying" || (m.kind === "change" && m.stage === "building" && !approval)) && !root.prUrl) throw new TreeError("Open the pull request first (open_pull_request)");
    if (m.kind === "change" && m.stage === "building" && !approval) await this.check(m, root);
    this.deps.db.update(schema.missions).set({ pendingStage: next, stageSummary: summary, docs: [...new Set([...m.docs, ...found])], updatedAt: Date.now() }).where(eq(schema.missions.id, id)).run();
    return approval ? "Sent to the person for approval. You are done until they answer." : "Stage finished. agentSwarm starts the next stage.";
  }

  /**
   * R10: the project's build and test commands, run in the lead's worktree before a change goes to you. A failure goes
   * back to the lead with the output; the same failure three times in a row and it must ask you.
   */
  private async check(m: MissionRow, root: RunRow): Promise<void> {
    const profile = this.deps.projects.get(m.projectId).profile ?? {};
    const commands = [profile.build, profile.test].map((c) => c?.trim()).filter((c): c is string => Boolean(c));
    if (!commands.length || !this.deps.backend || !root.workstationId) return;
    for (const command of commands) {
      const r = await this.deps.backend.call<ExecResult>(root.workstationId, { op: "exec", scope: root.worktreeScope, command, timeoutMs: CHECK_TIMEOUT_MS }, { timeoutMs: CHECK_TIMEOUT_MS + 60_000 });
      if (r.exitCode === 0 && !r.timedOut) continue;
      const failures = (m.options?.checkFailures ?? 0) + 1;
      this.setOptions(m.id, { checkFailures: failures }, `checks failed (${command})`);
      const tail = r.output.trim().split("\n").slice(-40).join("\n");
      if (failures >= MAX_CHECK_FAILURES) {
        throw new TreeError(`The checks failed ${failures} times in a row (${command}):\n${tail}\n\nStop trying: ask_user, saying what fails and what you tried.`);
      }
      throw new TreeError(`The project's checks failed (${command}${r.timedOut ? ", timed out" : `, exit ${r.exitCode}`}):\n${tail}\n\nFix it, git_push, then call stage_done again.`);
    }
    if (m.options?.checkFailures) this.setOptions(m.id, { checkFailures: 0 });
  }

  /** Merges into the mission's options; `trouble` notes something that went wrong (it earns a retrospective). */
  private setOptions(id: string, patch: Partial<NonNullable<MissionRow["options"]>>, trouble?: string): void {
    const m = this.row(id);
    const options = { ...(m.options ?? {}), ...patch, ...(trouble ? { trouble: [...(m.options?.trouble ?? []), trouble].slice(-20) } : {}) };
    this.deps.db.update(schema.missions).set({ options }).where(eq(schema.missions.id, id)).run();
  }

  /** R10: what a new project's lead suggests as its settings; used when you keep it. */
  private suggestProfile(id: string, profile: Record<string, unknown>): string {
    this.setOptions(id, { profile });
    return "Noted: the project will start with these settings when the person keeps it.";
  }

  private async docsOnBranch(m: MissionRow, branch: string): Promise<string[]> {
    const project = this.deps.projects.get(m.projectId);
    const found: string[] = [];
    for (const name of DOC_NAMES) {
      const res = await this.deps.git(["cat-file", "-e", `refs/heads/${branch}:${m.docsPath}/${name}`], { cwd: project.mirrorPath });
      if (res.code === 0) found.push(name);
    }
    return found;
  }

  /**
   * The web, done by swarmd. A researcher (limited) gets a fixed number of searches and page reads, and is told
   * to report once most of its time or budget is gone: it used to search until its 30 minutes ran out.
   */
  private webOps(run: RunRow, binding: RunBinding, limited = false): WebToolOps {
    const { web, agents, db } = this.deps;
    const used = { search: 0, fetch: 0 };
    const started = Date.now();
    const spend = () => db.select({ cost: schema.runs.costUsd, budget: schema.runs.budgetUsd }).from(schema.runs).where(eq(schema.runs.id, run.id)).get();
    // As the run's own limit counts it: its whole budget when it has one, else this execution's spending.
    const startCost = spend()?.cost ?? 0;
    const budgetUsed = (): boolean => {
      const now = spend();
      if (!now) return false;
      return now.budget !== null ? now.cost >= now.budget * RESEARCH_LIMITS.wrapUpShare : now.cost - startCost >= run.limits.maxCostUsd * RESEARCH_LIMITS.wrapUpShare;
    };
    const stop = (kind: "search" | "fetch"): string | null => {
      if (!limited) return null;
      const why = used[kind] >= RESEARCH_LIMITS[kind] ? `you have used all ${RESEARCH_LIMITS[kind]} ${kind === "search" ? "searches" : "page reads"}`
        : Date.now() - started >= run.limits.maxDurationMs * RESEARCH_LIMITS.wrapUpShare ? "most of your time is used"
        : budgetUsed() ? "most of your budget is used" : null;
      if (!why) {
        used[kind] += 1;
        return null;
      }
      return `Not done: ${why}. Do not search or read more. Write your report now from what you found, with the links, and say what you could not check.`;
    };
    return {
      fetch: async (url, offset) => {
        const limit = stop("fetch");
        if (limit) return limit;
        try {
          return fenced(pageWindow(await web.fetch(url, binding.signal), offset));
        } catch (error) {
          if (error instanceof FetchError) throw new TreeError(error.message);
          throw error;
        }
      },
      search: async (query) => {
        const limit = stop("search");
        if (limit) return limit;
        const agent = agents.get(run.agentId);
        const res = await web.search(query, { endpointId: agent.endpointId, modelId: agent.modelId }, binding.signal);
        if (!res) return null;
        binding.addCost(res.costUsd);
        return fenced(res.text);
      },
    };
  }

  // ---- helpers --------------------------------------------------------------------------

  private missionOf(run: RunRow): MissionRow | null {
    if (!run.missionId) return null;
    return this.deps.db.select().from(schema.missions).where(eq(schema.missions.id, run.missionId)).get() ?? null;
  }

  private pickLead(projectId: string, agentId?: string) {
    if (agentId) {
      const agent = this.deps.agents.get(agentId);
      if (agent.projectId !== projectId || agent.ephemeral) throw badRequest("That agent cannot lead missions in this project");
      return agent;
    }
    const standing = this.deps.agents.list(projectId);
    const lead = standing.find((a) => a.name.toLowerCase() === "lead") ?? standing[0];
    if (!lead) throw badRequest("Create an agent for this project first; it leads the missions");
    return this.deps.agents.get(lead.id);
  }

  private post(missionId: string, author: MessageRow["author"], kind: MessageRow["kind"], text: string, source: Source, discordMessageId: string | null = null, now = Date.now()): MissionMessageView {
    const row = this.deps.db.insert(schema.missionMessages).values({ missionId, author, kind, text: text.slice(0, 8000), source, discordMessageId, createdAt: now }).returning().get();
    this.deps.db.update(schema.missions).set({ updatedAt: now }).where(eq(schema.missions.id, missionId)).run();
    const view = messageView(row);
    this.deps.bus.publish({ kind: "mission_message", message: view });
    return view;
  }

  private emit(id: string): void {
    this.deps.bus.publish({ kind: "mission", mission: this.view(id) });
  }

  private toView(m: MissionRow): MissionView {
    const { tree, projects } = this.deps;
    const project = projects.get(m.projectId);
    const root = tree.run(m.rootRunId);
    const ref = root.prState === "merged" ? project.defaultBranch : root.branch;
    // Local projects have no GitHub: their documents open in the dashboard.
    const docUrl = (name: string) => project.kind === "local"
      ? `/api/projects/${project.id}/blob?ref=${encodeURIComponent(root.branch)}&path=${encodeURIComponent(`${m.docsPath}/${name}`)}`
      : `https://github.com/${project.githubRepo}/blob/${ref}/${m.docsPath}/${name}`;
    const waitingForYou = GATES.has(m.stage)
      || (root.status === "waiting" && (root.waitingFor ?? []).includes(WAIT_FOR_USER))
      || (WORKING.has(m.stage) && TERMINAL.has(root.status) && !m.pendingStage && !this.deps.runs.isActive(root.id));
    return {
      id: m.id, projectId: m.projectId, projectName: project.name, githubRepo: project.githubRepo, title: m.title, intent: m.intent,
      stage: m.stage, fast: m.fast, leadAgentId: m.leadAgentId, rootRunId: m.rootRunId, treeId: m.treeId, branch: root.branch, docsPath: m.docsPath,
      docs: m.docs.map((name) => ({ name, url: docUrl(name) })),
      budgetUsd: root.budgetUsd ?? 0, costUsd: tree.subtreeCost(root), leadStatus: root.status, waitingForYou: waitingForYou && !ENDED.has(m.stage),
      stageSummary: m.stageSummary, prUrl: root.prUrl, prState: root.prState, retro: m.retro, discordThreadId: m.discordThreadId, error: m.error,
      createdAt: m.createdAt, updatedAt: m.updatedAt, endedAt: m.endedAt,
      kind: m.kind, origin: m.origin,
    };
  }
}

function messageView(r: MessageRow): MissionMessageView {
  return { id: r.id, missionId: r.missionId, author: r.author, kind: r.kind, text: r.text, source: r.source, createdAt: r.createdAt };
}
