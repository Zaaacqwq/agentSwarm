import { Type, type Static } from "typebox";

// ---- auth --------------------------------------------------------------------------------
export const Credentials = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});
export type Credentials = Static<typeof Credentials>;

export interface Me {
  readonly id: string;
  readonly username: string;
  readonly role: "admin";
}

// ---- endpoints ---------------------------------------------------------------------------
export const EndpointKind = Type.Union([Type.Literal("openrouter"), Type.Literal("openai-compatible")]);
export type EndpointKind = Static<typeof EndpointKind>;

export const CreateEndpoint = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  kind: EndpointKind,
  baseUrl: Type.Optional(Type.String({ maxLength: 300, pattern: "^https?://" })),
  apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type CreateEndpoint = Static<typeof CreateEndpoint>;

/** API keys go in and never come out: views only say whether one is stored. */
export interface EndpointView {
  readonly id: string;
  readonly name: string;
  readonly kind: EndpointKind;
  readonly baseUrl: string;
  readonly hasKey: boolean;
  readonly createdAt: number;
}

export interface ModelView {
  readonly id: string;
  readonly name: string;
  readonly vision: boolean;
  readonly contextWindow: number;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

// ---- GitHub and projects -----------------------------------------------------------------
export const SetGitHubToken = Type.Object({ token: Type.String({ minLength: 20, maxLength: 400 }) });
export type SetGitHubToken = Static<typeof SetGitHubToken>;

export interface GitHubStatus {
  readonly configured: boolean;
  readonly login: string | null;
  readonly expiresAt: number | null;
  readonly checkedAt: number | null;
  readonly error: string | null;
}

export const CreateProject = Type.Object({
  githubRepo: Type.String({ pattern: "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$" }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
export type CreateProject = Static<typeof CreateProject>;

export interface ProjectView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly githubRepo: string;
  readonly defaultBranch: string;
  readonly protectedAt: number | null;
  readonly lastFetchedAt: number | null;
  readonly createdAt: number;
  /** R5: "local" projects live only on this Mac (sandbox experiments, ideas). */
  readonly kind: "github" | "local";
  readonly profile: ProjectProfile;
  /** R7: its tickets' ids start with this, e.g. FRI. */
  readonly ticketPrefix: string;
  /** Paths of the local files (not their contents) written into every worktree. */
  readonly files: readonly { readonly path: string; readonly updatedAt: number }[];
}

// ---- project profile and files (R5) -------------------------------------------------------
export const ProjectProfile = Type.Object({
  platform: Type.Optional(Type.String({ maxLength: 80 })),
  setup: Type.Optional(Type.String({ maxLength: 1000 })),
  build: Type.Optional(Type.String({ maxLength: 1000 })),
  test: Type.Optional(Type.String({ maxLength: 1000 })),
  knownFailures: Type.Optional(Type.String({ maxLength: 2000 })),
  rules: Type.Optional(Type.String({ maxLength: 4000 })),
  reviewRuntime: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("claude_code"), Type.Literal("codex")])),
  autoApproveBugs: Type.Optional(Type.Boolean()),
  /** iOS apps (R6): what to build for the simulator. Agents find the rest with `xcodebuild -list`. */
  ios: Type.Optional(Type.Object({
    project: Type.Optional(Type.String({ maxLength: 200, pattern: "\\.xcodeproj$" })),
    workspace: Type.Optional(Type.String({ maxLength: 200, pattern: "\\.xcworkspace$" })),
    scheme: Type.Optional(Type.String({ maxLength: 100 })),
    /** e.g. com.apple.CoreSimulator.SimDeviceType.iPhone-17 */
    deviceType: Type.Optional(Type.String({ maxLength: 150, pattern: "^[A-Za-z0-9.-]+$" })),
  })),
  /** Mac apps (R9): what to build for the desktop, and whether the app under test may use the network. */
  mac: Type.Optional(Type.Object({
    project: Type.Optional(Type.String({ maxLength: 200, pattern: "\\.xcodeproj$" })),
    workspace: Type.Optional(Type.String({ maxLength: 200, pattern: "\\.xcworkspace$" })),
    scheme: Type.Optional(Type.String({ maxLength: 100 })),
    network: Type.Optional(Type.Boolean()),
  })),
  /** Sites besides the local dev server where the browser may click and type (R6): origins, e.g. https://staging.example.com. */
  testSites: Type.Optional(Type.Array(Type.String({ maxLength: 200, pattern: "^https?://[^/\\s]+$" }), { maxItems: 20 })),
  /** R8: a product: feature tickets also update the changelog and store copy. */
  product: Type.Optional(Type.Boolean()),
});
export type ProjectProfile = Static<typeof ProjectProfile>;

export const SetProjectProfile = Type.Object({
  profile: ProjectProfile,
  ticketPrefix: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9]{0,5}$" })),
});
export type SetProjectProfile = Static<typeof SetProjectProfile>;

/** A file path inside the worktree; the segments are checked further by the server (no ".", "..", empty or .git segments). */
export const PROJECT_FILE_PATH = "^[A-Za-z0-9._@+ /-]{1,200}$";
export const PutProjectFile = Type.Object({
  path: Type.String({ pattern: PROJECT_FILE_PATH }),
  content: Type.String({ maxLength: 256 * 1024 }),
});
export type PutProjectFile = Static<typeof PutProjectFile>;

export interface RepoChoice {
  readonly fullName: string;
  readonly private: boolean;
  readonly description: string;
  readonly updatedAt: string;
}

export const CreateLocalProject = Type.Object({ name: Type.String({ minLength: 1, maxLength: 60, pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*$" }) });
export type CreateLocalProject = Static<typeof CreateLocalProject>;

export const MachineSettings = Type.Object({ denyPorts: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 200 }) });
export type MachineSettings = Static<typeof MachineSettings>;

/** The model a native run switches to when its own refuses the content or keeps failing. */
export const BackupModel = Type.Object({ endpointId: Type.String({ minLength: 1, maxLength: 100 }), modelId: Type.String({ minLength: 1, maxLength: 200 }) });
export type BackupModel = Static<typeof BackupModel>;
export const ModelSettings = Type.Object({ backup: Type.Union([BackupModel, Type.Null()]) });
export type ModelSettings = Static<typeof ModelSettings>;

export interface PushView {
  readonly id: number;
  readonly runId: string;
  readonly branch: string;
  readonly headSha: string | null;
  readonly status: "pushed" | "rejected" | "failed";
  readonly reason: string | null;
  readonly createdAt: number;
}

// ---- workstations ------------------------------------------------------------------------
export type WorkstationStatus = "free" | "busy" | "unhealthy";

export interface WorkstationView {
  readonly id: string;
  readonly status: WorkstationStatus;
  readonly runId: string | null;
  readonly lastCheckAt: number | null;
  readonly lastError: string | null;
}

// ---- agents and runs ---------------------------------------------------------------------
export const CreateAgent = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9 _-]*$" }),
  projectId: Type.String(),
  role: Type.String({ minLength: 1, maxLength: 40 }),
  endpointId: Type.String(),
  modelId: Type.String({ minLength: 1, maxLength: 200 }),
  instructions: Type.Optional(Type.String({ maxLength: 8000 })),
});
export type CreateAgent = Static<typeof CreateAgent>;

export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly role: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly instructions: string;
  readonly runtime: AgentRuntime;
  readonly parentId: string | null;
  readonly ephemeral: boolean;
  readonly createdAt: number;
}

export const CreateRun = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120 }),
  brief: Type.String({ minLength: 1, maxLength: 20_000 }),
  /** The whole tree's budget: this run and everything it spawns. */
  budgetUsd: Type.Optional(Type.Number({ minimum: 0.05, maximum: 50 })),
});
export type CreateRun = Static<typeof CreateRun>;

export const RunMessage = Type.Object({ text: Type.String({ minLength: 1, maxLength: 20_000 }) });
export type RunMessage = Static<typeof RunMessage>;

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface RunReport {
  readonly summary: string;
  readonly tests: string;
  readonly unfinished: string[];
  readonly recommendations?: string[];
}

export interface ReviewVerdict {
  readonly approved: boolean;
  readonly comments: string;
  readonly reviewRunId: string;
  readonly headSha: string;
}

export interface RunView {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly brief: string;
  readonly branch: string;
  readonly workstationId: string | null;
  readonly status: RunStatus;
  readonly report: RunReport | null;
  readonly error: string | null;
  readonly turns: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly agentName: string;
  readonly agentRole: string;
  readonly treeId: string | null;
  readonly parentRunId: string | null;
  readonly depth: number;
  readonly kind: "task" | "review";
  readonly baseBranch: string | null;
  readonly budgetUsd: number | null;
  readonly review: ReviewVerdict | null;
  readonly reviewOf: string | null;
  readonly mergedAt: number | null;
  readonly prUrl: string | null;
  readonly waitingFor: string[] | null;
  readonly missionId: string | null;
  readonly prState: "open" | "merged" | "closed" | null;
  readonly cleanedAt: number | null;
  readonly runtime: AgentRuntime;
  /** CLI runs: the cost at API prices as the CLI reports it (paid by the subscription, not the budget). */
  readonly estimatedUsd: number;
  /** Eyes and hands it was given (R6). */
  readonly needs: readonly RunNeed[];
}

/** R6: how busy this Mac is with simulators and browsers. memoryPressure: 1 normal, 2 warning, 4 critical. */
export interface MachineLoadView {
  readonly heavySlots: number;
  readonly heavyRunning: number;
  readonly heavyQueued: number;
  readonly memoryPressure: number;
}

/** What a run may use beyond its worktree (R6). Each holds a heavy slot while the run works. */
export type RunNeed = "simulator" | "browser" | "desktop";
export const RUN_NEEDS: readonly RunNeed[] = ["simulator", "browser", "desktop"];

/** Every run of one tree, and what the whole tree has spent. */
export interface TreeView {
  readonly treeId: string;
  readonly nodes: RunView[];
  readonly totalCostUsd: number;
}

export type RunEventType =
  | "status"
  | "user"
  | "assistant"
  | "tool_start"
  | "tool_end"
  | "push"
  | "results"
  | "error";

export interface RunEventView {
  readonly id: number;
  readonly runId: string;
  readonly type: RunEventType;
  readonly data: Record<string, unknown>;
  readonly createdAt: number;
}

// ---- missions (R3) -----------------------------------------------------------------------
export type MissionStage =
  | "intake" | "research" | "discussion" | "planning" | "awaiting_approval"
  | "building" | "verifying" | "awaiting_merge" | "review" | "retro" | "done" | "cancelled";

export const CreateMission = Type.Object({
  projectId: Type.String(),
  idea: Type.String({ minLength: 3, maxLength: 4000 }),
  /** Skip research and discussion (small changes). */
  fast: Type.Optional(Type.Boolean()),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0.1, maximum: 50 })),
  /** The lead; default: the project's agent named Lead, else its newest agent. */
  agentId: Type.Optional(Type.String()),
  /** R5: which flow (default feature). */
  kind: Type.Optional(Type.Union([
    Type.Literal("change"), Type.Literal("newproject"), Type.Literal("quick"),
    Type.Literal("feature"), Type.Literal("bug"), Type.Literal("research"), Type.Literal("experiment"), Type.Literal("marketing"),
  ])),
});
export type CreateMission = Static<typeof CreateMission>;
/**
 * R10: "change" (an existing project), "newproject" and "quick" are what you choose; the older kinds remain for
 * missions started before R10.
 */
export type MissionKind = "change" | "newproject" | "quick" | "feature" | "bug" | "research" | "experiment" | "marketing";

export const MissionReply = Type.Object({ text: Type.String({ minLength: 1, maxLength: 8000 }) });
export type MissionReply = Static<typeof MissionReply>;

export const MissionBudget = Type.Object({ budgetUsd: Type.Number({ minimum: 0.1, maximum: 50 }) });
export type MissionBudget = Static<typeof MissionBudget>;

export interface MissionView {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly githubRepo: string;
  readonly title: string;
  readonly intent: string;
  readonly stage: MissionStage;
  readonly fast: boolean;
  readonly leadAgentId: string;
  readonly rootRunId: string;
  readonly treeId: string;
  readonly branch: string;
  readonly docsPath: string;
  /** Links to the mission's documents on GitHub, for the ones that exist on its branch. */
  readonly docs: { readonly name: string; readonly url: string }[];
  readonly budgetUsd: number;
  readonly costUsd: number;
  /** What the lead is doing right now: running, waiting (for sub-agents or for you), or idle. */
  readonly leadStatus: RunStatus;
  readonly waitingForYou: boolean;
  readonly stageSummary: string | null;
  readonly prUrl: string | null;
  readonly prState: "open" | "merged" | "closed" | null;
  readonly retro: string | null;
  readonly discordThreadId: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | null;
  readonly kind: MissionKind;
  /** "linear": from the R5 Linear integration, since removed (kept for the record). */
  readonly origin: "dashboard" | "discord" | "linear" | "ticket";
}

export interface MissionMessageView {
  readonly id: number;
  readonly missionId: string;
  readonly author: "user" | "lead" | "system";
  readonly kind: "text" | "question" | "stage" | "approval" | "error";
  readonly text: string;
  readonly source: "dashboard" | "discord" | "agentswarm" | "linear";
  readonly createdAt: number;
}

// ---- Discord (R3) ------------------------------------------------------------------------
export const SetDiscord = Type.Object({
  /** Omit to keep the stored token. */
  token: Type.Optional(Type.String({ minLength: 50, maxLength: 200 })),
  channelId: Type.String({ pattern: "^[0-9]{17,20}$" }),
  ownerId: Type.String({ pattern: "^[0-9]{17,20}$" }),
});
export type SetDiscord = Static<typeof SetDiscord>;

export interface DiscordStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly botTag: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly ownerId: string | null;
  readonly error: string | null;
}

/** What the WebSocket sends: every run event and every run row change. */
export type LiveMessage =
  | { readonly kind: "event"; readonly event: RunEventView }
  | { readonly kind: "run"; readonly run: RunView }
  | { readonly kind: "workstation"; readonly workstation: WorkstationView }
  | { readonly kind: "cli"; readonly cli: CliStatusView }
  | { readonly kind: "mission"; readonly mission: MissionView }
  | { readonly kind: "mission_message"; readonly message: MissionMessageView }
  | { readonly kind: "ticket"; readonly ticket: TicketView }
  | { readonly kind: "ticket_removed"; readonly id: string }
  | { readonly kind: "desktop"; readonly desktop: DesktopView };

// ---- CLI workers (R4) --------------------------------------------------------------------
export type AgentRuntime = "native" | "claude_code" | "codex";
export type CliRuntimeName = Exclude<AgentRuntime, "native">;

export const SetCli = Type.Object({
  claudeEnabled: Type.Optional(Type.Boolean()),
  codexEnabled: Type.Optional(Type.Boolean()),
  /** A long-lived token from `claude setup-token`; omit to keep the stored one. */
  claudeToken: Type.Optional(Type.String({ minLength: 20, maxLength: 500, pattern: "^sk-ant-[A-Za-z0-9_-]+$" })),
  clearClaudeToken: Type.Optional(Type.Boolean()),
  /** Per CLI runtime, how many runs at once. */
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  /** No new Claude Code runs once a subscription window is used past this share. */
  fiveHourLimit: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1 })),
  sevenDayLimit: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1 })),
});
export type SetCli = Static<typeof SetCli>;

export interface CliQuotaView {
  readonly fiveHour: number;
  readonly fiveHourResetsAt: number | null;
  readonly sevenDay: number;
  readonly sevenDayResetsAt: number | null;
  readonly status: string;
  readonly at: number;
}

export interface CodexLoginView {
  readonly state: "waiting" | "done" | "failed";
  readonly url: string | null;
  readonly code: string | null;
  readonly error: string | null;
}

export interface CodexWorkstationView {
  readonly workstationId: string;
  readonly signedInAt: number | null;
  readonly login: CodexLoginView | null;
}

export interface CliRuntimeView {
  readonly enabled: boolean;
  readonly version: string | null;
  readonly pinned: string;
  /** Whether a sub-agent can be spawned with it now, and if not, why. */
  readonly available: boolean;
  readonly reason: string | null;
}

export interface CliStatusView {
  readonly claude: CliRuntimeView & { readonly hasToken: boolean; readonly quota: CliQuotaView | null };
  readonly codex: CliRuntimeView & { readonly workstations: readonly CodexWorkstationView[] };
  readonly maxConcurrent: number;
  readonly fiveHourLimit: number;
  readonly sevenDayLimit: number;
  /** When the installed versions were last read. */
  readonly checkedAt: number | null;
}

export interface CliTestResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly workstationId: string | null;
}

// ---- system check ------------------------------------------------------------------------
export interface CheckItem {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

// ---- the board (R7) ----------------------------------------------------------------------------
/** Backlog and todo are yours; in progress, needs you and done follow the ticket's mission. */
/** R10: "review": its pull request or result waits for you to look. */
export type TicketStatus = "backlog" | "todo" | "in_progress" | "needs_you" | "review" | "done" | "canceled";
export const TICKET_STATUSES: readonly TicketStatus[] = ["backlog", "todo", "in_progress", "needs_you", "review", "done", "canceled"];
/** A registered project, a fresh local sandbox (experiments), or an idea with no repository yet. */
export type TicketSpace = "project" | "sandbox" | "ideas";
/** What the ticket waits for you to do, when it does. */
/** R10: "decide": a new project or a quick test's result waits for you to keep it, send it back or finish it. */
export type TicketNeed = "answer" | "approve" | "merge" | "decide" | "failed";

export interface TicketAttachmentView {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly url: string;
}

export interface TicketView {
  readonly id: string;
  /** e.g. FRI-12 */
  readonly key: string;
  readonly space: TicketSpace;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly githubRepo: string | null;
  readonly title: string;
  readonly description: string;
  readonly kind: MissionKind;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  readonly priority: number;
  readonly status: TicketStatus;
  readonly position: number;
  readonly missionId: string | null;
  readonly createdBy: string;
  readonly fromTicket: string | null;
  readonly commitAttachments: boolean;
  readonly external: { readonly key: string; readonly url: string } | null;
  readonly attachments: readonly TicketAttachmentView[];
  /** R10: files it brings (written to inputs/). */
  readonly files: readonly TicketFileView[];
  /** R10: the keys of tickets that must be done first, and whether one of them is not done yet. */
  readonly blockedBy: readonly string[];
  readonly blocked: boolean;
  /** R10: a new project or quick test that can still become a GitHub repository (Keep). */
  readonly keepable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** From its mission, once started. */
  readonly stage: MissionStage | null;
  readonly need: TicketNeed | null;
  readonly costUsd: number;
  readonly prUrl: string | null;
  /** R10: how it was asked to be worked. */
  readonly options: TicketOptions;
  /** R10: earlier attempts (retried), oldest first. */
  readonly attempts: readonly TicketAttemptView[];
  /** Agents of its mission running right now. */
  readonly working: number;
  /** Todo tickets: how many are ahead of it. */
  readonly queuePosition: number | null;
}

const TicketKindT = Type.Union([
  Type.Literal("change"), Type.Literal("newproject"), Type.Literal("quick"),
  Type.Literal("feature"), Type.Literal("bug"), Type.Literal("research"), Type.Literal("experiment"), Type.Literal("marketing"),
]);
/** R10: how a ticket is worked. planFirst: a plan for you before the change; marketing: a marketer takes part; researchOnly: a quick test that only finds out. */
export const TicketOptions = Type.Object({
  planFirst: Type.Optional(Type.Boolean()),
  marketing: Type.Optional(Type.Boolean()),
  researchOnly: Type.Optional(Type.Boolean()),
});
export type TicketOptions = Static<typeof TicketOptions>;
const TicketSpaceT = Type.Union([Type.Literal("project"), Type.Literal("sandbox"), Type.Literal("ideas")]);
const PriorityT = Type.Integer({ minimum: 0, maximum: 4 });

export const CreateTicket = Type.Object({
  space: TicketSpaceT,
  /** Required for space "project". */
  projectId: Type.Optional(Type.String({ maxLength: 64 })),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 8000 }),
  kind: TicketKindT,
  priority: Type.Optional(PriorityT),
  status: Type.Optional(Type.Union([Type.Literal("backlog"), Type.Literal("todo")])),
  commitAttachments: Type.Optional(Type.Boolean()),
  options: Type.Optional(TicketOptions),
  /** R10: the keys of tickets that must be done first. */
  blockedBy: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Z][A-Z0-9]{0,5}-[0-9]+$", maxLength: 20 }), { maxItems: 10 })),
});
export type CreateTicket = Static<typeof CreateTicket>;

/** Only before it starts: after that, add to it by talking to its lead. */
export const UpdateTicket = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 8000 })),
  kind: Type.Optional(TicketKindT),
  priority: Type.Optional(PriorityT),
  space: Type.Optional(TicketSpaceT),
  projectId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  commitAttachments: Type.Optional(Type.Boolean()),
  blockedBy: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Z][A-Z0-9]{0,5}-[0-9]+$", maxLength: 20 }), { maxItems: 10 })),
});
export type UpdateTicket = Static<typeof UpdateTicket>;

/** Where you put it: a column you own (backlog, todo, canceled) and, for the order, its neighbours there. */
export const MoveTicket = Type.Object({
  status: Type.Union([Type.Literal("backlog"), Type.Literal("todo"), Type.Literal("canceled")]),
  after: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  before: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
});
export type MoveTicket = Static<typeof MoveTicket>;

export interface TicketEventView {
  readonly id: number;
  readonly ticketId: string;
  readonly actor: string;
  readonly kind: "created" | "edited" | "status" | "started" | "ended" | "attachment" | "promoted" | "retried" | "sent_back" | "kept" | "dropped" | "cleaned";
  readonly data: Record<string, unknown>;
  readonly createdAt: number;
}

/** 立项: a research or experiment ticket becomes a project. repo: an existing empty one to use (owner/name). */
export const PromoteTicket = Type.Object({ repo: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$", maxLength: 140 })) });
export type PromoteTicket = Static<typeof PromoteTicket>;

export const TicketSettings = Type.Object({ maxActive: Type.Integer({ minimum: 1, maximum: 8 }) });
export type TicketSettings = Static<typeof TicketSettings>;

// ---- the team's memory (R8) --------------------------------------------------------------------
export type Role = "lead" | "researcher" | "architect" | "developer" | "reviewer" | "qa" | "marketer";
export const ROLES: readonly Role[] = ["lead", "researcher", "architect", "developer", "reviewer", "qa", "marketer"];
export type LessonScope = "team" | "project" | "role";

export interface LessonView {
  readonly id: string;
  readonly scope: LessonScope;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly role: Role | null;
  readonly title: string;
  readonly text: string;
  /** "you", or the agent that wrote it (then it is advice, not a requirement). */
  readonly author: string;
  readonly source: string | null;
  readonly pinned: boolean;
  readonly retired: boolean;
  /** An agent's lesson for the whole team or a role: shown to no agent until you approve it. */
  readonly suggested: boolean;
  readonly uses: number;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const RoleT = Type.Union([Type.Literal("lead"), Type.Literal("researcher"), Type.Literal("architect"), Type.Literal("developer"), Type.Literal("reviewer"), Type.Literal("qa"), Type.Literal("marketer")]);
const ScopeT = Type.Union([Type.Literal("team"), Type.Literal("project"), Type.Literal("role")]);

export const CreateLesson = Type.Object({
  scope: ScopeT,
  projectId: Type.Optional(Type.String({ maxLength: 64 })),
  role: Type.Optional(RoleT),
  title: Type.String({ minLength: 3, maxLength: 160 }),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
});
export type CreateLesson = Static<typeof CreateLesson>;

export const UpdateLesson = Type.Object({
  title: Type.Optional(Type.String({ minLength: 3, maxLength: 160 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  pinned: Type.Optional(Type.Boolean()),
  retired: Type.Optional(Type.Boolean()),
  /** Approve an agent's suggested lesson: from then on agents see it. */
  approved: Type.Optional(Type.Literal(true)),
});
export type UpdateLesson = Static<typeof UpdateLesson>;

export interface LessonVersionView {
  readonly id: number;
  readonly title: string;
  readonly text: string;
  readonly author: string;
  readonly createdAt: number;
}

export interface HandbookView {
  readonly role: Role;
  readonly text: string;
  readonly updatedBy: string;
  readonly updatedAt: number | null;
  /** Still the text agentSwarm started with. */
  readonly isDefault: boolean;
  readonly versions: readonly { readonly id: number; readonly author: string; readonly createdAt: number }[];
}

export const SetHandbook = Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) });
export type SetHandbook = Static<typeof SetHandbook>;

export interface HandbookProposalView {
  readonly id: string;
  readonly role: Role;
  readonly change: string;
  readonly why: string;
  readonly author: string;
  readonly source: string | null;
  readonly status: "open" | "accepted" | "rejected";
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

/** Accept as proposed (appended to the handbook), or with the handbook's whole new text as you edited it. */
export const DecideProposal = Type.Object({
  accept: Type.Boolean(),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});
export type DecideProposal = Static<typeof DecideProposal>;

// ---- desktop sessions (R9) ---------------------------------------------------------------------
export type DesktopSessionStatus = "queued" | "pending" | "active" | "ended" | "denied";

/** An agent's turn at this Mac's desktop, to test one app. */
export interface DesktopSessionView {
  readonly id: string;
  readonly runId: string;
  readonly runTitle: string;
  readonly agent: string;
  readonly projectName: string;
  /** The board ticket the run works for, if any. */
  readonly ticketKey: string | null;
  readonly purpose: string;
  readonly minutes: number;
  readonly status: DesktopSessionStatus;
  readonly until: number | null;
  /** The person is using the Mac: the agent's input waits until then. */
  readonly pausedUntil: number | null;
  /** The app under test, once it is open. */
  readonly app: string | null;
  readonly endReason: string | null;
  readonly createdAt: number;
}

/** The desktop helper on this Mac, and the sessions that are not over. */
export interface DesktopView {
  readonly helper: {
    readonly running: boolean;
    readonly screenRecording: boolean;
    readonly accessibility: boolean;
    readonly watching: boolean;
    readonly stoppedByUser: boolean;
  };
  /** The active session first, then the one waiting for you, then the queue. */
  readonly sessions: readonly DesktopSessionView[];
}

// ---- R10: review, send back, retry ---------------------------------------------------------------
export interface TicketAttemptView {
  readonly missionId: string;
  readonly prUrl: string | null;
  readonly worker: string;
  readonly note: string;
  readonly at: number;
}

/** A comment on a line of the change (the new side), or on the whole when path is absent. */
export const ReviewComment = Type.Object({
  path: Type.Optional(Type.String({ maxLength: 500 })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  text: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type ReviewComment = Static<typeof ReviewComment>;
export const SendBack = Type.Object({ comments: Type.Array(ReviewComment, { minItems: 1, maxItems: 50 }) });
export type SendBack = Static<typeof SendBack>;

export const RetryTicket = Type.Object({
  /** Who writes the code this time: the lead itself, or a Claude Code or Codex sub-agent. */
  worker: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("claude_code"), Type.Literal("codex")])),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type RetryTicket = Static<typeof RetryTicket>;

/** R10: merge the pull request, as it was when you looked at it. */
export const MergeTicket = Type.Object({ sha: Type.String({ pattern: "^[0-9a-f]{40}$" }) });
export type MergeTicket = Static<typeof MergeTicket>;

/** The change a ticket's mission made, from its branch against where it started. */
export interface TicketDiffView {
  readonly base: string;
  readonly branch: string;
  /** The commit shown: Merge sends it back, so only what you looked at is merged. */
  readonly head: string;
  readonly files: readonly DiffFileView[];
  /** Files left out: the change was too big to show whole. */
  readonly truncated: boolean;
}

export interface DiffFileView {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /** The unified diff's hunks (from the first @@), empty for binary files. */
  readonly patch: string;
}

/** R10: a file attached to a ticket (an assignment, data, a document). */
export interface TicketFileView {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly url: string;
}

/** R10: a file in the inbox on this Mac (~/agentSwarm-inbox). */
export interface InboxFileView {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: number;
}

/** R10: a file the work produced (outputs/ and its result documents), to download. */
export interface OutputFileView {
  readonly path: string;
  readonly bytes: number;
}

/** R10: a file to take from the inbox on this Mac. */
export const FromInbox = Type.Object({ name: Type.String({ minLength: 1, maxLength: 255 }) });
export type FromInbox = Static<typeof FromInbox>;
