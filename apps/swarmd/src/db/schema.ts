import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin"] }).notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("users_username_uq").on(t.username)]);

export const loginSessions = sqliteTable("login_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [uniqueIndex("login_sessions_token_uq").on(t.tokenHash), index("login_sessions_user_idx").on(t.userId)]);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  meta: json<Record<string, unknown>>("meta"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("audit_log_time_idx").on(t.createdAt)]);

export const endpoints = sqliteTable("endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["openrouter", "openai-compatible"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeySealed: text("api_key_sealed"),
  createdAt: integer("created_at").notNull(),
});

/** One row (id "github"): the token agentSwarm pushes and opens pull requests with. */
export const githubCredentials = sqliteTable("github_credentials", {
  id: text("id").primaryKey(),
  tokenSealed: text("token_sealed").notNull(),
  login: text("login"),
  expiresAt: integer("expires_at"),
  checkedAt: integer("checked_at"),
  error: text("error"),
  updatedAt: integer("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  githubRepo: text("github_repo").notNull(),
  remoteUrl: text("remote_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  mirrorPath: text("mirror_path").notNull(),
  protectedAt: integer("protected_at"),
  lastFetchedAt: integer("last_fetched_at"),
  createdAt: integer("created_at").notNull(),
  // R5: projects beyond GitHub, and what agents should know about them.
  /** "github": a repository on GitHub. "local": only on this Mac (sandbox experiments, ideas); nothing is pushed anywhere. */
  kind: text("kind", { enum: ["github", "local"] }).notNull().default("github"),
  /** The project's profile (platform, commands, rules); shown to every agent working in it. */
  profile: json<ProjectProfile>("profile"),
  /** The Linear project whose tickets come here. */
  linearProjectId: text("linear_project_id"),
}, (t) => [uniqueIndex("projects_slug_uq").on(t.slug), uniqueIndex("projects_repo_uq").on(t.githubRepo)]);

export interface ProjectProfile {
  readonly platform?: string;
  readonly setup?: string;
  readonly build?: string;
  readonly test?: string;
  /** Tests known to fail that are not the agents' business. */
  readonly knownFailures?: string;
  /** Free-form rules, e.g. "production runs on this Mac: never deploy". */
  readonly rules?: string;
  /** Who reviews sub-agents' work in this project. */
  readonly reviewRuntime?: "native" | "claude_code" | "codex";
  /** Bug tickets skip plan approval (the merge gate stays). */
  readonly autoApproveBugs?: boolean;
}

/** Local files a project needs that are not in git (Local.xcconfig, .env): written into every worktree, never committed. */
export const projectFiles = sqliteTable("project_files", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  contentSealed: text("content_sealed").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.path] })]);

export const workstations = sqliteTable("workstations", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["free", "busy", "unhealthy"] }).notNull(),
  runId: text("run_id"),
  lastCheckAt: integer("last_check_at"),
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
  /** R4: when Codex was last confirmed signed in on this workstation (null: not signed in). */
  codexLoginAt: integer("codex_login_at"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  endpointId: text("endpoint_id").notNull().references(() => endpoints.id),
  modelId: text("model_id").notNull(),
  instructions: text("instructions").notNull(),
  runtime: text("runtime", { enum: ["native", "claude_code", "codex"] }).notNull(),
  // R2: the agent tree.
  parentId: text("parent_id"),
  depth: integer("depth").notNull(),
  budgetUsd: real("budget_usd"),
  /** Sub-agents exist for one run and are not listed with the standing agents. */
  ephemeral: integer("ephemeral", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("agents_project_idx").on(t.projectId)]);

export interface RunLimits {
  readonly maxTurns: number;
  readonly maxDurationMs: number;
  readonly maxCostUsd: number;
}

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  branch: text("branch").notNull(),
  worktreeScope: text("worktree_scope").notNull(),
  /** The workstation holding this run's worktree once it has one; follow-ups go back to it. */
  workstationId: text("workstation_id"),
  status: text("status", { enum: ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] }).notNull(),
  pendingMessage: text("pending_message"),
  report: json<{ summary: string; tests: string; unfinished: string[] }>("report"),
  error: text("error"),
  turns: integer("turns").notNull(),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  costUsd: real("cost_usd").notNull(),
  limits: json<RunLimits>("limits").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  // R2: the agent tree.
  treeId: text("tree_id"),
  parentRunId: text("parent_run_id"),
  depth: integer("depth").notNull().default(0),
  /** What this run's branch was cut from; null means the project's default branch. */
  baseBranch: text("base_branch"),
  /** This node's own spending limit, carved from its parent's; null falls back to limits.maxCostUsd. */
  budgetUsd: real("budget_usd"),
  kind: text("kind", { enum: ["task", "review"] }).notNull().default("task"),
  /** For a review run: the run under review. */
  reviewOf: text("review_of"),
  /** On a reviewed run: the reviewer's verdict, for exactly the commit that was reviewed. */
  review: json<{ approved: boolean; comments: string; reviewRunId: string; headSha: string }>("review"),
  /** For a review run: the commit it reviews (the branch tip when the review started). */
  reviewSha: text("review_sha"),
  mergedAt: integer("merged_at"),
  prUrl: text("pr_url"),
  /** While waiting: the child runs it is waiting for ("@user" while it waits for the person's answer). */
  waitingFor: json<string[]>("waiting_for"),
  // R3: missions and cleanup.
  missionId: text("mission_id"),
  /** On a root with a pull request: what GitHub last said about it. */
  prState: text("pr_state", { enum: ["open", "merged", "closed"] }),
  /** When the tree's worktrees and branches were removed (after its pull request was merged or closed). */
  cleanedAt: integer("cleaned_at"),
  // R4: CLI workers.
  /** Claude Code's session id or Codex's thread id: follow-ups continue it. */
  cliSession: text("cli_session"),
  /** What a subscription run would have cost at API prices (as the CLI reports it); not charged to budgets. */
  estimatedUsd: real("estimated_usd").notNull().default(0),
}, (t) => [
  index("runs_agent_idx").on(t.agentId, t.createdAt),
  index("runs_status_idx").on(t.status),
  index("runs_branch_idx").on(t.projectId, t.branch),
  // Two task runs never share a branch; reviewers check out the branch they review.
  uniqueIndex("runs_task_branch_uq").on(t.projectId, t.branch).where(sql`kind = 'task'`),
  index("runs_tree_idx").on(t.treeId),
  index("runs_parent_idx").on(t.parentRunId),
  index("runs_mission_idx").on(t.missionId),
]);

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  data: json<Record<string, unknown>>("data").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("run_events_run_idx").on(t.runId, t.id)]);

export const agentSessions = sqliteTable("agent_sessions", {
  runId: text("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  messages: json<unknown[]>("messages").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const gitPushes = sqliteTable("git_pushes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  branch: text("branch").notNull(),
  headSha: text("head_sha"),
  status: text("status", { enum: ["pushed", "rejected", "failed"] }).notNull(),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("git_pushes_project_idx").on(t.projectId, t.id)]);

export const MISSION_STAGES = [
  "intake", "research", "discussion", "planning", "awaiting_approval", "building", "verifying", "awaiting_merge", "retro", "done", "cancelled",
] as const;
export type MissionStage = (typeof MISSION_STAGES)[number];
export const MISSION_KINDS = ["feature", "bug", "research", "experiment"] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

/** One idea pursued in one project, from your first sentence to a merged pull request (R3). */
export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Your words, as you said them; never edited. */
  intent: text("intent").notNull(),
  stage: text("stage", { enum: MISSION_STAGES }).notNull(),
  fast: integer("fast", { mode: "boolean" }).notNull(),
  leadAgentId: text("lead_agent_id").notNull().references(() => agents.id),
  /** The lead's run: every stage is one execution of it, on one branch and worktree. */
  rootRunId: text("root_run_id").notNull(),
  treeId: text("tree_id").notNull(),
  docsPath: text("docs_path").notNull(),
  /** Set by stage_done / request_approval; applied when the lead's execution ends. */
  pendingStage: text("pending_stage", { enum: MISSION_STAGES }),
  /** What the lead said when it last finished a stage. */
  stageSummary: text("stage_summary"),
  retro: text("retro"),
  /** The mission documents found on its branch so far (file names under docsPath). */
  docs: json<string[]>("docs").notNull(),
  discordThreadId: text("discord_thread_id"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  endedAt: integer("ended_at"),
  // R5
  /** Which flow it follows (missions/stages.ts). */
  kind: text("kind", { enum: MISSION_KINDS }).notNull().default("feature"),
  /** Where it was started; Linear missions talk in their ticket, Discord only notifies. */
  origin: text("origin", { enum: ["dashboard", "discord", "linear"] }).notNull().default("dashboard"),
}, (t) => [index("missions_project_idx").on(t.projectId, t.createdAt), index("missions_stage_idx").on(t.stage)]);

export const missionMessages = sqliteTable("mission_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  author: text("author", { enum: ["user", "lead", "system"] }).notNull(),
  /** question: the lead waits for an answer; approval: the plan waits for yours. */
  kind: text("kind", { enum: ["text", "question", "stage", "approval", "error"] }).notNull(),
  text: text("text").notNull(),
  /** Where you wrote it (user messages): dashboard, discord or linear. */
  source: text("source", { enum: ["dashboard", "discord", "agentswarm", "linear"] }).notNull(),
  discordMessageId: text("discord_message_id"),
  createdAt: integer("created_at").notNull(),
  /** R5: when it was posted to the mission's Linear session (null: not yet, or not a Linear mission). */
  linearDeliveredAt: integer("linear_delivered_at"),
}, (t) => [index("mission_messages_idx").on(t.missionId, t.id)]);

/** R5: Linear webhook deliveries, stored before they are answered and handled after (5-second limit). */
export const linearEvents = sqliteTable("linear_events", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  receivedAt: integer("received_at").notNull(),
  processedAt: integer("processed_at"),
  error: text("error"),
}, (t) => [index("linear_events_pending_idx").on(t.processedAt, t.receivedAt)]);

/** R5: one Linear agent session (a ticket given to agentSwarm) and the mission it became. */
export const linearSessions = sqliteTable("linear_sessions", {
  sessionId: text("session_id").primaryKey(),
  issueId: text("issue_id").notNull(),
  /** e.g. ZAC-42 */
  issueKey: text("issue_key").notNull(),
  issueUrl: text("issue_url").notNull(),
  title: text("title").notNull(),
  /** Linear priority: 1 urgent … 4 low, 0 none. */
  priority: integer("priority").notNull(),
  status: text("status", { enum: ["queued", "active", "ended", "refused"] }).notNull(),
  missionId: text("mission_id"),
  /** What to start with once it leaves the queue. */
  request: json<{ kind: MissionKind; text: string; linearProjectId: string | null; teamId: string | null }>("request").notNull(),
  /** Sent stage checklist, to avoid resending the same. */
  planDigest: text("plan_digest"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("linear_sessions_status_idx").on(t.status, t.priority, t.createdAt), index("linear_sessions_mission_idx").on(t.missionId)]);

/** Small settings rows (id "discord": the bot). Secrets are sealed. */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  value: json<Record<string, unknown>>("value").notNull(),
  secretSealed: text("secret_sealed"),
  updatedAt: integer("updated_at").notNull(),
});
