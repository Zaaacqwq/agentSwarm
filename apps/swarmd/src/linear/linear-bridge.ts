import { and, asc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import type { LiveMessage, MissionMessageView, MissionView } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { MissionKind } from "../db/schema.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { MissionService } from "../missions/mission-service.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { AgentService } from "../agents/agent-service.ts";
import type { TreeService } from "../agents/tree-service.ts";
import type { GitHubService } from "../github/github-service.ts";
import { gitOk, type GitRunner } from "../github/git.ts";
import { ENDED, STAGE_LABEL, stagesOf } from "../missions/stages.ts";
import type { ActivityContent, ActivityOptions, LinearIssue, LinearState, PlanStep } from "./linear-client.ts";
import type { LinearService } from "./linear-service.ts";

type SessionRow = typeof schema.linearSessions.$inferSelect;
const ACTOR = "linear";
const BODY_MAX = 9000;
const RESEND_EVERY_MS = 60_000;

export interface LinearBridgeDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly linear: LinearService;
  readonly missions: MissionService;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly tree: TreeService;
  readonly github: GitHubService;
  readonly git: GitRunner;
  /** Links in tickets point here. */
  readonly dashboardUrl: string;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (t: string) => (t.length > BODY_MAX ? `${t.slice(0, BODY_MAX)}\n…` : t);

/** Labels that choose a flow (English or Chinese). */
const LABELS: [RegExp, MissionKind][] = [[/^(bug|缺陷|错误)$/i, "bug"], [/^(research|调研|研究)$/i, "research"], [/^(feature|功能|需求)$/i, "feature"], [/^(experiment|实验)$/i, "experiment"]];
/** A reply that approves the plan: the button, or a short yes. Anything else is a change request. */
const APPROVE = /^\s*(approve|approved|lgtm|go|yes|ok|okay|批准|同意|通过|可以|好|好的|没问题)[\s.!。！]*$/i;
/** A reply that turns a finished idea or experiment into a real project. */
const PROMOTE = /^\s*(立项|promote|create (a |the )?project|make it a project)[\s.!。！]*$/i;
const REPO_NAME = /^\s*([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\s*$/;

/**
 * Linear for missions (R5). A ticket delegated to agentSwarm becomes a mission (or waits in the queue);
 * the mission's conversation, stages, documents and pull request show in the ticket's agent session,
 * and the ticket's state follows. Only the owner's tickets and replies are acted on.
 */
export class LinearBridge {
  private readonly deps: LinearBridgeDeps;
  private events: Promise<void> = Promise.resolve();
  /** Per session: what is sent to Linear goes in order. */
  private readonly outbox = new Map<string, Promise<void>>();
  private readonly states = new Map<string, LinearState[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: LinearBridgeDeps) {
    this.deps = deps;
    deps.bus.subscribe((m) => this.onLive(m));
  }

  /** Handles what arrived while swarmd was down, then resends what Linear has not got yet, every minute. */
  start(): void {
    this.drain();
    this.timer ??= setInterval(() => {
      this.resend();
      void this.pump().catch(() => undefined);
    }, RESEND_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits until everything queued so far is handled and sent (tests, shutdown). */
  async idle(): Promise<void> {
    await this.events;
    await Promise.all([...this.outbox.values()]);
  }

  // ---- incoming --------------------------------------------------------------------------

  drain(): void {
    this.events = this.events.then(() => this.processPending()).catch((e: Error) => this.deps.log("linear events failed", { error: e.message }));
  }

  private async processPending(): Promise<void> {
    const { db } = this.deps;
    for (;;) {
      const ev = db.select().from(schema.linearEvents).where(isNull(schema.linearEvents.processedAt)).orderBy(asc(schema.linearEvents.receivedAt)).limit(1).get();
      if (!ev) return;
      let error: string | null = null;
      try {
        await this.deps.linear.noteEvent();
        await this.handle(ev.payload);
      } catch (e) {
        error = (e as Error).message.slice(0, 500);
        this.deps.log("linear event failed", { delivery: ev.deliveryId, error });
      }
      db.update(schema.linearEvents).set({ processedAt: Date.now(), error }).where(eq(schema.linearEvents.deliveryId, ev.deliveryId)).run();
    }
  }

  private async handle(p: Obj): Promise<void> {
    if (p.type !== "AgentSessionEvent") return;
    if (p.action === "created") return this.onCreated(p);
    if (p.action === "prompted") return this.onPrompted(p);
  }

  private async onCreated(p: Obj): Promise<void> {
    const { db, linear } = this.deps;
    const session = obj(p.agentSession);
    const sessionId = str(session.id);
    if (!sessionId || this.session(sessionId)) return;
    // Linear marks a session unresponsive after 10 seconds without a word.
    await this.send(sessionId, { type: "thought", body: "Got it — reading the ticket." });
    const token = await linear.accessToken();
    const owner = linear.stored().ownerUserId;
    const creator = str(obj(session.creator).id) || str(session.creatorId) || str(obj(p.actor).id);
    const issueId = str(obj(session.issue).id) || str(session.issueId);
    const now = Date.now();
    const refuse = async (reason: string, issue?: LinearIssue) => {
      db.insert(schema.linearSessions).values({
        sessionId, issueId, issueKey: issue?.identifier ?? "?", issueUrl: issue?.url ?? "", title: issue?.title ?? "", priority: issue?.priority ?? 0,
        status: "refused", missionId: null, request: { kind: "feature", text: "", linearProjectId: issue?.projectId ?? null, teamId: issue?.teamId ?? null }, planDigest: null, createdAt: now, updatedAt: now,
      }).onConflictDoNothing().run();
      await this.send(sessionId, { type: "error", body: reason });
    };
    if (!owner) return refuse("agentSwarm has no owner set yet: choose yourself under Linear in the agentSwarm settings, then delegate the ticket again.");
    if (creator !== owner) return refuse("agentSwarm only takes tickets from its owner.");
    if (!issueId) return refuse("This session has no ticket.");
    const issue = await linear.api.issue(token, issueId);
    const route = this.route(issue);
    if ("error" in route) return refuse(route.error, issue);
    const context = str(p.promptContext);
    const text = [
      issue.title,
      issue.description.trim(),
      context && !issue.description.trim() ? context.slice(0, 4000) : "",
      `(Linear ticket ${issue.identifier}: ${issue.url})`,
    ].filter(Boolean).join("\n\n");
    db.insert(schema.linearSessions).values({
      sessionId, issueId: issue.id, issueKey: issue.identifier, issueUrl: issue.url, title: issue.title, priority: issue.priority, status: "queued", missionId: null,
      request: { kind: route.kind, text, linearProjectId: issue.projectId, teamId: issue.teamId }, planDigest: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    await this.pump();
    const row = this.session(sessionId)!;
    if (row.status === "queued") {
      const ahead = this.queued().findIndex((r) => r.sessionId === sessionId);
      await this.send(sessionId, { type: "thought", body: `Queued: ${linear.stored().maxActive} tickets are being worked on; ${ahead} ahead of this one (by priority).` });
    }
  }

  /** Which project and flow a ticket gets, from its Linear project and labels. */
  private route(issue: LinearIssue): { kind: MissionKind; local: "sandbox" | "ideas" | null; projectId: string | null } | { error: string } {
    const s = this.deps.linear.stored();
    const label = issue.labels.map((l) => LABELS.find(([re]) => re.test(l.trim()))?.[1]).find(Boolean);
    if (issue.projectId && issue.projectId === s.sandboxProjectId) return { kind: "experiment", local: "sandbox", projectId: null };
    if (issue.projectId && issue.projectId === s.ideasProjectId) return { kind: "research", local: "ideas", projectId: null };
    const project = issue.projectId ? this.deps.projects.byLinearProject(issue.projectId) : null;
    if (!project) {
      return { error: `This ticket's Linear project (${issue.projectName ?? "none"}) is not connected to a repository. Connect it in the agentSwarm settings (Projects), or move the ticket to Sandbox or Ideas.` };
    }
    if (label === "experiment") return { error: "Experiments run in the Sandbox project; move the ticket there." };
    return { kind: label ?? "feature", local: null, projectId: project.id };
  }

  private async onPrompted(p: Obj): Promise<void> {
    const { linear, missions } = this.deps;
    const sessionId = str(obj(p.agentSession).id);
    const row = this.session(sessionId);
    if (!row || row.status === "refused") return;
    const activity = obj(p.agentActivity);
    const body = (str(activity.body) || str(obj(activity.content).body)).trim();
    const signal = str(activity.signal);
    const author = str(obj(activity.user).id) || str(activity.userId) || str(obj(p.actor).id);
    if (author && author !== linear.stored().ownerUserId) return;

    if (signal === "stop") {
      if (row.status === "queued") {
        this.setSession(row.sessionId, { status: "ended" });
        return this.send(sessionId, { type: "response", body: "Removed from the queue; nothing was started." });
      }
      if (row.missionId) {
        const m = missions.row(row.missionId);
        if (!ENDED.has(m.stage)) missions.cancel(ACTOR, m.id);
        return this.send(sessionId, { type: "response", body: `Stopped during ${STAGE_LABEL[m.stage].toLowerCase()}. Agents were cancelled; anything pushed stays on the branch.` });
      }
      return;
    }
    if (!body) return;
    if (row.status === "queued") {
      this.setSession(row.sessionId, { request: { ...row.request, text: `${row.request.text}\n\nAdded while it waited:\n${body}` } });
      return this.send(sessionId, { type: "thought", body: "Still queued; your message will be part of the brief when it starts." });
    }
    if (!row.missionId) return;
    const m = missions.row(row.missionId);
    if (ENDED.has(m.stage)) {
      const project = this.deps.projects.get(m.projectId);
      const awaitingRepo = row.planDigest?.includes('"awaitingRepo":true');
      if (project.kind === "local" && m.stage === "done" && (PROMOTE.test(body) || (awaitingRepo && REPO_NAME.test(body)))) {
        return this.promote(row, REPO_NAME.exec(body)?.[1] ?? null);
      }
      return this.send(sessionId, { type: "response", body: `This ticket's work has ended (${m.stage}). To do more, delegate a new ticket.${project.kind === "local" && m.stage === "done" ? " To turn it into a real project, reply 立项 (or \"promote\")." : ""}` });
    }
    if (m.stage === "awaiting_approval") {
      if (body.toLowerCase() === "request changes") return this.send(sessionId, { type: "elicitation", body: "What should change in the plan? Reply with the changes." });
      if (APPROVE.test(body)) {
        missions.approve(ACTOR, m.id);
        return;
      }
      missions.requestChanges(ACTOR, m.id, body, "linear");
      return;
    }
    missions.reply(ACTOR, m.id, body, "linear");
  }

  // ---- the queue -------------------------------------------------------------------------

  private queued(): SessionRow[] {
    return this.deps.db.select().from(schema.linearSessions).where(eq(schema.linearSessions.status, "queued")).all()
      // Urgent first; "no priority" (0) last; then oldest first.
      .sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.createdAt - b.createdAt);
  }

  /** Starts queued tickets while fewer than maxActive are being worked on. */
  async pump(): Promise<void> {
    const { db, linear } = this.deps;
    for (;;) {
      const active = db.select({ id: schema.linearSessions.sessionId }).from(schema.linearSessions).where(eq(schema.linearSessions.status, "active")).all().length;
      if (active >= linear.stored().maxActive) return;
      const next = this.queued()[0];
      if (!next) return;
      await this.startSession(next);
    }
  }

  private async startSession(row: SessionRow): Promise<void> {
    const { missions, projects } = this.deps;
    this.setSession(row.sessionId, { status: "active" });
    try {
      const kind = row.request.kind;
      const projectId = kind === "experiment" || (kind === "research" && row.request.linearProjectId === this.deps.linear.stored().ideasProjectId)
        ? (await projects.createLocal(ACTOR, `${row.issueKey} ${row.title}`.slice(0, 60))).id
        : projects.byLinearProject(row.request.linearProjectId ?? "")?.id;
      if (!projectId) throw new Error("The ticket's Linear project is no longer connected to a repository");
      this.ensureLead(projectId);
      const m = missions.create(ACTOR, { projectId, idea: row.request.text, kind }, "linear", Date.now(), { origin: "linear", title: `${row.issueKey} ${row.title}` });
      this.setSession(row.sessionId, { missionId: m.id });
      await this.send(row.sessionId, { type: "thought", body: `Started a ${kind} mission in ${m.projectName}. Progress shows in the checklist; questions and the plan come here.` });
      await this.setIssueState(row, "started");
      this.sync(m);
    } catch (error) {
      this.setSession(row.sessionId, { status: "refused" });
      await this.send(row.sessionId, { type: "error", body: `Could not start: ${(error as Error).message}` });
    }
  }

  /** A project's missions need a lead; new projects (local ones, freshly registered ones) borrow the standard one. */
  private ensureLead(projectId: string): void {
    const { agents } = this.deps;
    if (agents.list(projectId).length) return;
    const template = agents.list().find((a) => a.name.toLowerCase() === "lead") ?? agents.list()[0];
    if (!template) throw new Error("Create a lead agent first (Agents page): new projects copy its model");
    agents.create(ACTOR, { name: "Lead", projectId, role: template.role, endpointId: template.endpointId, modelId: template.modelId, instructions: template.instructions });
  }

  // ---- an idea or experiment becomes a project ("立项") ------------------------------------

  private async promote(row: SessionRow, givenRepo: string | null): Promise<void> {
    const { projects, github, linear, missions, git } = this.deps;
    const old = missions.row(row.missionId!);
    const local = projects.get(old.projectId);
    const root = this.deps.tree.run(old.rootRunId);
    await this.send(row.sessionId, { type: "thought", body: "Creating the project: a private repository with what was found so far." });
    const token = await github.token();
    let repo = givenRepo;
    if (!repo) {
      const name = local.name.replace(/^[A-Z]+-\d+\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `project-${row.issueKey.toLowerCase()}`;
      try {
        repo = (await github.client.createRepo(token, name, row.title)).fullName;
      } catch (error) {
        this.setSession(row.sessionId, { planDigest: JSON.stringify({ awaitingRepo: true }) });
        return this.send(row.sessionId, { type: "elicitation", body: `agentSwarm could not create a repository (${(error as Error).message.slice(0, 200)}). Create an empty private repository on GitHub and reply with its name (owner/repo).` });
      }
    }
    const remote = projects.remoteUrlFor(repo);
    // What the idea or experiment produced is on its mission branch: it becomes the new repository's main.
    await gitOk(git, ["push", "--quiet", remote, `refs/heads/${root.branch}:refs/heads/main`], { cwd: local.mirrorPath, token, timeoutMs: 300_000 });
    const project = await projects.create(ACTOR, { githubRepo: repo, name: row.title.slice(0, 80) });
    const issue = await linear.api.issue(await linear.accessToken(), row.issueId);
    const lp = await linear.api.createProject(await linear.accessToken(), row.title.slice(0, 80), [issue.teamId]).catch(() => null);
    if (lp) {
      projects.setProfile(ACTOR, project.id, { profile: {}, linearProjectId: lp.id });
      await linear.api.updateIssue(await linear.accessToken(), row.issueId, { projectId: lp.id }).catch(() => undefined);
    }
    this.ensureLead(project.id);
    const docs = old.docs.map((d) => `${old.docsPath}/${d}`).join(", ");
    const m = missions.create(ACTOR, {
      projectId: project.id, kind: "feature",
      idea: `${old.intent}\n\nThis started as ${old.kind === "experiment" ? "an experiment" : "an idea"}; what was found is already in this repository (${docs || old.docsPath}). Conclusion:\n${old.retro ?? old.stageSummary ?? ""}`,
    }, "linear", Date.now(), { origin: "linear", title: `${row.issueKey} ${row.title}` });
    this.setSession(row.sessionId, { missionId: m.id, status: "active", planDigest: null });
    await this.send(row.sessionId, { type: "thought", body: `Project created: https://github.com/${repo}${lp ? " (and a Linear project for its tickets)" : ""}. Starting the feature mission.` });
    await this.setIssueState(row, "started");
    this.sync(m);
  }

  // ---- outgoing --------------------------------------------------------------------------

  private onLive(msg: LiveMessage): void {
    if (msg.kind === "mission_message") this.deliver(msg.message);
    if (msg.kind === "mission") this.sync(msg.mission);
  }

  /** One mission message into the ticket: chat as thoughts, questions and the plan as elicitations. */
  private deliver(msg: MissionMessageView): void {
    const row = this.byMission(msg.missionId);
    if (!row) return;
    if (msg.author === "user" && msg.source === "linear") return this.markDelivered(msg.id);
    // The stage change itself shows in the checklist.
    if (msg.author === "system" && msg.kind === "stage") return this.markDelivered(msg.id);
    const m = this.deps.missions.row(msg.missionId);
    let content: ActivityContent;
    let opts: ActivityOptions = {};
    if (msg.author === "user") content = { type: "thought", body: `You (${msg.source}): ${msg.text}` };
    else if (msg.kind === "question") content = { type: "elicitation", body: msg.text };
    else if (msg.kind === "approval") {
      const plan = this.deps.missions.view(m.id).docs.find((d) => d.name === "plan.md");
      content = { type: "elicitation", body: `**The plan is ready for your approval.**\n\n${msg.text}${plan ? `\n\nPlan: ${this.absolute(plan.url)}` : ""}\n\nApprove it, or reply with what to change.` };
      opts = { select: [{ label: "Approve", value: "approve" }, { label: "Request changes", value: "Request changes" }] };
    } else if (msg.kind === "error") content = { type: "error", body: msg.text };
    else if (msg.author === "system" && m.stage === "awaiting_merge" && /https:\/\/github\.com\/\S+\/pull\/\d+/.test(msg.text)) content = { type: "elicitation", body: msg.text };
    else content = { type: "thought", body: msg.text };
    this.enqueue(row.sessionId, async () => {
      if (this.delivered(msg.id)) return;
      await this.send(row.sessionId, content, opts);
      this.markDelivered(msg.id);
    });
  }

  /** The checklist, links and ticket state follow the mission; when it ends, a final answer and the next ticket. */
  private sync(view: MissionView): void {
    const row = this.byMission(view.id);
    if (!row || row.status === "refused") return;
    const project = this.deps.projects.get(view.projectId);
    const plan = this.plan(view);
    const urls = [
      { label: "agentSwarm mission", url: `${this.deps.dashboardUrl}/missions/${view.id}` },
      ...view.docs.map((d) => ({ label: d.name, url: this.absolute(d.url) })),
      ...(view.prUrl ? [{ label: "Pull request", url: view.prUrl }] : []),
    ];
    const state = view.stage === "cancelled" ? "canceled" : view.stage === "done" ? "completed" : view.stage === "awaiting_merge" ? "review" : "started";
    const digest = JSON.stringify({ plan, urls, state });
    if (digest === row.planDigest) return;
    this.setSession(row.sessionId, { planDigest: digest });
    const ending = ENDED.has(view.stage) && row.status === "active";
    if (ending) this.setSession(row.sessionId, { status: "ended" });
    this.enqueue(row.sessionId, async () => {
      const token = await this.deps.linear.accessToken();
      await this.deps.linear.api.updateSession(token, row.sessionId, { plan, externalUrls: urls }).catch((e: Error) => this.deps.log("linear session update failed", { error: e.message }));
      await this.setIssueState(row, state);
      if (ending) {
        await this.send(row.sessionId, { type: "response", body: await this.finalAnswer(view, project.kind) });
        await this.pump();
      }
    });
  }

  private plan(view: MissionView): PlanStep[] {
    const stages = stagesOf({ kind: view.kind, fast: view.fast });
    const at = view.stage === "cancelled" ? -1 : stages.indexOf(view.stage);
    const steps: PlanStep[] = stages.map((s, i) => ({
      content: s === "awaiting_approval" ? "You approve the plan" : s === "awaiting_merge" ? "You merge the pull request" : STAGE_LABEL[s],
      status: view.stage === "done" || i < at ? "completed" : i === at ? "inProgress" : view.stage === "cancelled" ? "canceled" : "pending",
    }));
    // The work packages, as the tree has them.
    const root = this.deps.tree.run(view.rootRunId);
    for (const c of this.deps.tree.children(root.id).filter((r) => r.kind === "task")) {
      const status = c.mergedAt || c.status === "succeeded" ? "completed" : c.status === "cancelled" || c.status === "failed" ? "canceled" : "inProgress";
      steps.push({ content: `Work package: ${c.title}${c.mergedAt ? " (merged)" : ""}`, status });
    }
    return steps;
  }

  private async finalAnswer(view: MissionView, projectKind: "github" | "local"): Promise<string> {
    if (view.stage === "cancelled") return clip(`Cancelled.${view.error ? ` ${view.error}` : ""}`);
    const parts = [view.retro ?? view.stageSummary ?? "Done."];
    if (view.prUrl) parts.push(`Merged: ${view.prUrl}`);
    if (projectKind === "local") {
      // No GitHub page to link to: the main document comes along.
      const name = view.kind === "experiment" ? "results.md" : "research.md";
      const text = view.docs.some((d) => d.name === name) ? await this.deps.projects.blob(view.projectId, view.branch, `${view.docsPath}/${name}`).catch(() => "") : "";
      if (text) parts.push(`---\n**${name}**\n\n${text}`);
      parts.push("To turn this into a real project, reply 立项 (or \"promote\").");
    }
    parts.push(`Cost: $${view.costUsd.toFixed(2)} · ${new Date(view.createdAt).toISOString().slice(0, 16).replace("T", " ")} → ${new Date(view.endedAt ?? Date.now()).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    return clip(parts.join("\n\n"));
  }

  private async setIssueState(row: SessionRow, want: "started" | "review" | "completed" | "canceled"): Promise<void> {
    const teamId = row.request.teamId;
    if (!teamId) return;
    try {
      const token = await this.deps.linear.accessToken();
      if (!this.states.has(teamId)) this.states.set(teamId, await this.deps.linear.api.states(token, teamId));
      const states = this.states.get(teamId)!;
      const pick = want === "review"
        ? states.find((s) => s.type === "started" && /review/i.test(s.name)) ?? states.find((s) => s.type === "started")
        : want === "started" ? states.find((s) => s.type === "started" && !/review/i.test(s.name)) ?? states.find((s) => s.type === "started")
        : states.find((s) => s.type === want);
      if (pick) await this.deps.linear.api.updateIssue(token, row.issueId, { stateId: pick.id });
    } catch (error) {
      this.deps.log("linear issue state failed", { issue: row.issueKey, error: (error as Error).message });
    }
  }

  /** Messages Linear did not get (it was down, or so was swarmd): sent again, in order. */
  resend(now = Date.now()): void {
    const linked = this.deps.db.select({ missionId: schema.linearSessions.missionId }).from(schema.linearSessions)
      .where(inArray(schema.linearSessions.status, ["active", "ended"])).all().map((r) => r.missionId).filter((id): id is string => Boolean(id));
    if (!linked.length) return;
    const pending = this.deps.db.select().from(schema.missionMessages)
      .where(and(inArray(schema.missionMessages.missionId, linked), isNull(schema.missionMessages.linearDeliveredAt), lt(schema.missionMessages.createdAt, now - 30_000), ne(schema.missionMessages.source, "linear")))
      .orderBy(asc(schema.missionMessages.id)).limit(100).all();
    for (const m of pending) {
      this.deliver({ id: m.id, missionId: m.missionId, author: m.author, kind: m.kind, text: m.text, source: m.source, createdAt: m.createdAt });
    }
  }

  // ---- helpers ---------------------------------------------------------------------------

  private async send(sessionId: string, content: ActivityContent, opts: ActivityOptions = {}): Promise<void> {
    const token = await this.deps.linear.accessToken();
    const c = "body" in content ? { ...content, body: clip(content.body) } : content;
    await this.deps.linear.api.createActivity(token, sessionId, c, opts);
  }

  private enqueue(sessionId: string, job: () => Promise<void>): void {
    const prev = this.outbox.get(sessionId) ?? Promise.resolve();
    const next = prev.then(job).catch((e: Error) => {
      this.deps.log("linear delivery failed", { sessionId, error: e.message });
      void this.deps.linear.noteError(`Could not post to Linear: ${e.message.slice(0, 200)}`);
    });
    this.outbox.set(sessionId, next);
    void next.finally(() => {
      if (this.outbox.get(sessionId) === next) this.outbox.delete(sessionId);
    });
  }

  private absolute(url: string): string {
    return url.startsWith("/") ? `${this.deps.dashboardUrl}${url}` : url;
  }

  private session(id: string): SessionRow | undefined {
    return this.deps.db.select().from(schema.linearSessions).where(eq(schema.linearSessions.sessionId, id)).get();
  }

  private byMission(missionId: string): SessionRow | undefined {
    return this.deps.db.select().from(schema.linearSessions).where(and(eq(schema.linearSessions.missionId, missionId), ne(schema.linearSessions.status, "refused"))).get();
  }

  private setSession(id: string, values: Partial<Pick<SessionRow, "status" | "missionId" | "request" | "planDigest">>): void {
    this.deps.db.update(schema.linearSessions).set({ ...values, updatedAt: Date.now() }).where(eq(schema.linearSessions.sessionId, id)).run();
  }

  private delivered(id: number): boolean {
    return Boolean(this.deps.db.select({ at: schema.missionMessages.linearDeliveredAt }).from(schema.missionMessages).where(eq(schema.missionMessages.id, id)).get()?.at);
  }

  private markDelivered(id: number): void {
    this.deps.db.update(schema.missionMessages).set({ linearDeliveredAt: Date.now() }).where(eq(schema.missionMessages.id, id)).run();
  }
}
