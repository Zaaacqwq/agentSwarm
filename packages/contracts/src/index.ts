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
}

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
  readonly runtime: "native";
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
}

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
  | "building" | "verifying" | "awaiting_merge" | "retro" | "done" | "cancelled";

export const CreateMission = Type.Object({
  projectId: Type.String(),
  idea: Type.String({ minLength: 3, maxLength: 4000 }),
  /** Skip research and discussion (small changes). */
  fast: Type.Optional(Type.Boolean()),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0.1, maximum: 50 })),
  /** The lead; default: the project's agent named Lead, else its newest agent. */
  agentId: Type.Optional(Type.String()),
});
export type CreateMission = Static<typeof CreateMission>;

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
}

export interface MissionMessageView {
  readonly id: number;
  readonly missionId: string;
  readonly author: "user" | "lead" | "system";
  readonly kind: "text" | "question" | "stage" | "approval" | "error";
  readonly text: string;
  readonly source: "dashboard" | "discord" | "agentswarm";
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
  | { readonly kind: "mission"; readonly mission: MissionView }
  | { readonly kind: "mission_message"; readonly message: MissionMessageView };

// ---- system check ------------------------------------------------------------------------
export interface CheckItem {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
