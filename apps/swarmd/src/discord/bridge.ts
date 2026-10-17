import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { CliQuotaView, DiscordStatus, LiveMessage, MissionMessageView, SetDiscord } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { audit } from "../audit.ts";
import { badRequest } from "../errors.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { ProjectService } from "../projects/project-service.ts";
import type { MissionService } from "../missions/mission-service.ts";
import { ENDED, STAGE_LABEL } from "../missions/stages.ts";
import { splitMessage, type ButtonEvent, type ChatTransport, type CommandEvent, type CommandSpec, type IncomingMessage, type ModalEvent } from "./transport.ts";

const ROW = "discord";
const ACTOR = "discord";

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "idea", description: "Start a mission: agentSwarm takes your idea to a pull request",
    options: [
      { name: "text", description: "What you want, in a sentence or two", type: "string", required: true, maxLength: 2000 },
      { name: "project", description: "Which repository (default: the only one)", type: "string", autocomplete: true },
      { name: "fast", description: "Small change: skip research and discussion", type: "boolean" },
      { name: "budget", description: "Budget in USD (default 3)", type: "number", min: 0.1, max: 50 },
    ],
  },
  { name: "status", description: "Missions and where they are" },
  { name: "stop", description: "Stop the mission of this thread" },
  { name: "budget", description: "Change the budget of this thread's mission", options: [{ name: "usd", description: "New budget in USD", type: "number", required: true, min: 0.1, max: 50 }] },
];

interface Stored {
  readonly channelId: string;
  readonly ownerId: string;
}

export interface BridgeDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly bus: EventBus;
  readonly missions: MissionService;
  readonly projects: ProjectService;
  readonly transport: ChatTransport;
  readonly dashboardUrl: string;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Claude's subscription windows, for /status (R4). */
  readonly quota?: () => CliQuotaView | null;
}

/**
 * Discord for missions: one thread per mission in one channel. Only the owner's messages and clicks
 * are acted on; everyone else is ignored and never reaches an agent.
 */
export class DiscordBridge {
  private readonly deps: BridgeDeps;
  private connected = false;
  private botTag: string | null = null;
  private channelName: string | null = null;
  private error: string | null = null;
  /** Per mission: deliveries happen in order. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly threads = new Map<string, Promise<string>>();
  private readonly queued = new Set<number>();
  /** Connects and disconnects one at a time; events from an older connection are ignored. */
  private lifecycle: Promise<void> = Promise.resolve();
  private generation = 0;
  private retry: NodeJS.Timeout | null = null;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    deps.bus.subscribe((msg) => this.onLive(msg));
  }

  status(): DiscordStatus {
    const s = this.stored();
    return { configured: Boolean(s), connected: this.connected, botTag: this.botTag, channelId: s?.channelId ?? null, channelName: this.channelName, ownerId: s?.ownerId ?? null, error: this.error };
  }

  async configure(actor: string, input: SetDiscord, now = Date.now()): Promise<DiscordStatus> {
    const old = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    const secretSealed = input.token ? await this.deps.secrets.seal(input.token) : old?.secretSealed ?? null;
    if (!secretSealed) throw badRequest("Add the bot token");
    const values = { value: { channelId: input.channelId, ownerId: input.ownerId }, secretSealed, updatedAt: now };
    this.deps.db.insert(schema.settings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
    audit(this.deps.db, actor, "discord.configure", input.channelId, { tokenChanged: Boolean(input.token) }, now);
    await this.start();
    return this.status();
  }

  /** Connects if configured; failures show in the status, never stop swarmd. */
  start(): Promise<void> {
    this.lifecycle = this.lifecycle.then(() => this.connect()).catch(() => undefined);
    return this.lifecycle;
  }

  stop(): Promise<void> {
    this.lifecycle = this.lifecycle.then(() => this.disconnect()).catch(() => undefined);
    return this.lifecycle;
  }

  private async disconnect(): Promise<void> {
    this.generation++;
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    this.connected = false;
    await this.deps.transport.disconnect().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    await this.disconnect();
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    const s = this.stored();
    if (!row?.secretSealed || !s) return;
    const gen = this.generation;
    const live = () => gen === this.generation;
    try {
      const { botTag } = await this.deps.transport.connect(await this.deps.secrets.open(row.secretSealed), {
        message: (m) => live() && this.onMessage(m),
        command: (e) => void (live() ? this.onCommand(e) : Promise.resolve()).catch((err: Error) => e.reply(`Something went wrong: ${err.message}`).catch(() => undefined)),
        button: (e) => void (live() ? this.onButton(e) : Promise.resolve()).catch((err: Error) => e.reply(err.message).catch(() => undefined)),
        modal: (e) => void (live() ? this.onModal(e) : Promise.resolve()).catch((err: Error) => e.reply(err.message).catch(() => undefined)),
        autocomplete: (e) => {
          if (!live() || e.userId !== s.ownerId || e.name !== "project") return void e.respond([]).catch(() => undefined);
          const q = e.value.toLowerCase();
          void e.respond(this.deps.projects.list().filter((p) => `${p.name} ${p.githubRepo}`.toLowerCase().includes(q)).map((p) => ({ name: p.githubRepo, value: p.id }))).catch(() => undefined);
        },
        failed: (error) => {
          if (!live()) return;
          this.connected = false;
          this.error = error.message;
          this.deps.log("discord failed", { error: error.message });
        },
      });
      this.botTag = botTag;
      this.channelName = await this.deps.transport.checkChannel(s.channelId);
      await this.deps.transport.registerCommands(s.channelId, COMMANDS);
      this.connected = true;
      this.error = null;
      this.deps.log("discord connected", { bot: botTag, channel: this.channelName });
      // What was posted while Discord was away, then a retry now and then for failed sends.
      this.flush();
      this.retry = setInterval(() => this.flush(), 60_000);
      this.retry.unref();
    } catch (error) {
      this.error = (error as Error).message.slice(0, 300);
      this.deps.log("discord connect failed", { error: this.error });
      await this.disconnect();
    }
  }

  /** Sends every recent mission message that has not reached Discord yet. */
  private flush(): void {
    if (!this.connected) return;
    const rows = this.deps.db.select().from(schema.missionMessages)
      .where(and(isNull(schema.missionMessages.discordMessageId), gt(schema.missionMessages.createdAt, Date.now() - 7 * 86_400_000)))
      .orderBy(asc(schema.missionMessages.id)).limit(200).all();
    for (const r of rows) {
      if (r.author === "user" && r.source === "discord") continue;
      const m = this.deps.missions.row(r.missionId);
      // Missions that ended before Discord knew about them do not get a thread now.
      if (!m.discordThreadId && ENDED.has(m.stage)) continue;
      this.enqueue(r);
    }
  }

  async test(): Promise<void> {
    const s = this.stored();
    if (!s || !this.connected) throw badRequest(`Discord is not connected${this.error ? `: ${this.error}` : ""}`);
    await this.deps.transport.send(s.channelId, { content: "agentSwarm is connected. Start a mission with /idea." });
  }

  /** The mission's thread, created on first use. */
  async ensureThread(missionId: string): Promise<string> {
    const m = this.deps.missions.row(missionId);
    if (m.discordThreadId) return m.discordThreadId;
    const s = this.stored();
    if (!s) throw new Error("Discord is not configured");
    let pending = this.threads.get(missionId);
    if (!pending) {
      pending = (async () => {
        const id = await this.deps.transport.createThread(s.channelId, m.title.slice(0, 90));
        this.deps.missions.setThread(missionId, id);
        const v = this.deps.missions.view(missionId);
        const intent = m.intent.split("\n").map((l) => `> ${l}`).join("\n");
        for (const part of splitMessage(`**New mission** in ${v.githubRepo}\n${intent}\n\nDashboard: ${this.deps.dashboardUrl}/missions/${missionId}\nReply in this thread to talk to the lead.`)) {
          await this.deps.transport.send(id, { content: part });
        }
        return id;
      })().finally(() => this.threads.delete(missionId));
      this.threads.set(missionId, pending);
    }
    return pending;
  }

  // ---- outgoing ---------------------------------------------------------------------------

  private onLive(msg: LiveMessage): void {
    if (!this.connected || msg.kind !== "mission_message") return;
    // Your Discord messages are already in the thread.
    if (msg.message.author === "user" && msg.message.source === "discord") return;
    this.enqueue(msg.message);
  }

  private enqueue(message: MissionMessageView): void {
    if (this.queued.has(message.id)) return;
    this.queued.add(message.id);
    const prev = this.chains.get(message.missionId) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(message))
      .catch((error: Error) => this.deps.log("discord delivery failed; will retry", { missionId: message.missionId, error: error.message }))
      .finally(() => this.queued.delete(message.id));
    this.chains.set(message.missionId, next);
  }

  private async deliver(message: MissionMessageView): Promise<void> {
    const sent = this.deps.db.select({ d: schema.missionMessages.discordMessageId }).from(schema.missionMessages).where(eq(schema.missionMessages.id, message.id)).get();
    if (sent?.d) return;
    const m = this.deps.missions.row(message.missionId);
    // The idea itself opens the thread.
    if (message.author === "user" && message.text === m.intent && message.createdAt === m.createdAt) {
      this.deps.missions.markDelivered(message.id, await this.ensureThread(m.id));
      return;
    }
    const thread = await this.ensureThread(m.id);
    const parts = splitMessage(this.format(message));
    let first: string | null = null;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      // The buttons name this plan: a click on an older plan's buttons is refused.
      const buttons = last && message.kind === "approval" ? [
        { id: `approve:${m.id}:${message.id}`, label: "Approve", style: "success" as const },
        { id: `changes:${m.id}:${message.id}`, label: "Request changes", style: "secondary" as const },
      ] : undefined;
      const id = await this.deps.transport.send(thread, { content: part, ...(buttons ? { buttons } : {}) });
      first ??= id;
    }
    if (first) this.deps.missions.markDelivered(message.id, first);
  }

  private format(message: MissionMessageView): string {
    if (message.author === "user") return `**You** (dashboard): ${message.text}`;
    if (message.author === "system") return message.kind === "stage" ? `**${message.text}**` : message.kind === "error" ? `**Problem:** ${message.text}` : `_${message.text}_`;
    switch (message.kind) {
      case "question": return `**Question from the lead:**\n${message.text}\n\n_Reply in this thread._`;
      case "approval": {
        const plan = this.deps.missions.view(message.missionId).docs.find((d) => d.name === "plan.md");
        return `**The plan is ready for your approval.**\n${message.text}${plan ? `\n\nFull plan: ${plan.url}` : ""}\n\nNothing is built until you approve.`;
      }
      case "stage": return `**Lead:** ${message.text}`;
      default: return `**Lead:** ${message.text}`;
    }
  }

  // ---- incoming ---------------------------------------------------------------------------

  private onMessage(m: IncomingMessage): void {
    const s = this.stored();
    if (!s || m.authorIsBot || m.authorId !== s.ownerId || !m.text.trim()) return;
    const mission = this.deps.missions.byThread(m.channelId);
    if (!mission) return;
    try {
      this.deps.missions.reply(ACTOR, mission.id, m.text.trim().slice(0, 8000), "discord", m.id);
    } catch (error) {
      void this.deps.transport.send(m.channelId, { content: `_Not delivered: ${(error as Error).message}_` }).catch(() => undefined);
    }
  }

  private owner(userId: string): boolean {
    return userId === this.stored()?.ownerId;
  }

  private async onCommand(e: CommandEvent): Promise<void> {
    if (!this.owner(e.userId)) return e.reply("This bot only takes commands from its owner.");
    const here = this.deps.missions.byThread(e.channelId);
    switch (e.name) {
      case "idea": {
        const project = this.resolveProject(typeof e.options.project === "string" ? e.options.project : undefined);
        const mission = this.deps.missions.create(ACTOR, {
          projectId: project.id, idea: String(e.options.text ?? ""),
          ...(e.options.fast === true ? { fast: true } : {}), ...(typeof e.options.budget === "number" ? { budgetUsd: e.options.budget } : {}),
        }, "discord");
        const thread = await this.ensureThread(mission.id);
        return e.reply(`Mission started in <#${thread}>.`);
      }
      case "status": {
        const all = this.deps.missions.list(30);
        const open = all.filter((m) => !ENDED.has(m.stage));
        const recent = all.filter((m) => ENDED.has(m.stage)).slice(0, 5);
        const line = (m: (typeof all)[number]) => `- **${m.title}**: ${STAGE_LABEL[m.stage]}${m.waitingForYou && !ENDED.has(m.stage) ? " (waiting for you)" : ""} · $${m.costUsd.toFixed(2)}${m.discordThreadId ? ` · <#${m.discordThreadId}>` : ""}`;
        const q = this.deps.quota?.() ?? null;
        const quota = q ? `\nClaude subscription: 5-hour window ${Math.round(q.fiveHour * 100)}% used, 7-day ${Math.round(q.sevenDay * 100)}%.` : "";
        return e.reply([open.length ? `**Open missions**\n${open.map(line).join("\n")}` : "No open missions.", recent.length ? `\n**Recently ended**\n${recent.map(line).join("\n")}` : "", quota].join("\n"));
      }
      case "stop":
        if (!here) return e.reply("Use /stop inside a mission's thread.");
        if (ENDED.has(here.stage)) return e.reply(`This mission is already ${here.stage}.`);
        return e.reply(`Stop **${here.title}**? Running agents are cancelled.`, { buttons: [{ id: `stop:${here.id}`, label: "Stop the mission", style: "danger" }] });
      case "budget": {
        if (!here) return e.reply("Use /budget inside a mission's thread.");
        const v = this.deps.missions.setBudget(ACTOR, here.id, Number(e.options.usd));
        return e.reply(`Budget is now $${v.budgetUsd.toFixed(2)}.`);
      }
      default:
        return e.reply("Unknown command.");
    }
  }

  private async onButton(e: ButtonEvent): Promise<void> {
    if (!this.owner(e.userId)) return e.reply("Only the owner can do that.");
    const [action, id, plan] = e.customId.split(":");
    if (!id) return;
    if ((action === "approve" || action === "changes") && Number(plan) !== this.deps.missions.latestApproval(id)) {
      return e.reply("That is an older version of the plan. Use the buttons on the latest one in this thread.");
    }
    if (action === "approve") {
      this.deps.missions.approve(ACTOR, id);
      return e.settle("**Approved.** Building starts.");
    }
    if (action === "changes") return e.showModal({ id: `changes:${id}`, title: "Request changes", label: "What should change in the plan?" });
    if (action === "stop") {
      this.deps.missions.cancel(ACTOR, id);
      return e.settle("**Stopped.**");
    }
  }

  private async onModal(e: ModalEvent): Promise<void> {
    if (!this.owner(e.userId)) return e.reply("Only the owner can do that.");
    const [action, id] = e.customId.split(":");
    if (action !== "changes" || !id) return;
    this.deps.missions.requestChanges(ACTOR, id, e.text, "discord");
    return e.reply(`**Changes requested:** ${e.text}`, { visible: true });
  }

  private resolveProject(value: string | undefined) {
    const projects = this.deps.projects.list();
    if (!value) {
      if (projects.length === 1) return projects[0]!;
      throw new Error(`Say which project: ${projects.map((p) => p.githubRepo).join(", ") || "(none yet: add one on the dashboard)"}`);
    }
    const v = value.toLowerCase();
    const found = projects.find((p) => p.id === value || p.githubRepo.toLowerCase() === v || p.slug === v || p.name.toLowerCase() === v || p.githubRepo.toLowerCase().endsWith(`/${v}`));
    if (!found) throw new Error(`No project ${value}`);
    return found;
  }

  private stored(): Stored | null {
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    const v = row?.value as Partial<Stored> | undefined;
    return v?.channelId && v.ownerId ? { channelId: v.channelId, ownerId: v.ownerId } : null;
  }
}
