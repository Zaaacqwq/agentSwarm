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
  /** R7: ticket ids look like <prefix>-<n>, e.g. FRI-12. */
  ticketPrefix: text("ticket_prefix"),
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
  /** R6: what to build for the simulator. */
  readonly ios?: { readonly project?: string; readonly workspace?: string; readonly scheme?: string; readonly deviceType?: string };
  /** R9: what to build for the desktop, and whether the app under test may use the network. */
  readonly mac?: { readonly project?: string; readonly workspace?: string; readonly scheme?: string; readonly network?: boolean };
  /** R6: origins besides localhost where the browser may click and type. */
  readonly testSites?: string[];
  /** R8: a product: its feature tickets also update the changelog and store copy (a marketer works alongside). */
  readonly product?: boolean;
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

/** What a run may use beyond its worktree (R6). */
export type RunNeed = "simulator" | "browser" | "desktop";

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
  /** Eyes and hands it was given (R6): a simulator, a browser. They hold a heavy slot while it runs. */
  needs: text("needs", { mode: "json" }).$type<RunNeed[]>(),
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
export const MISSION_KINDS = ["feature", "bug", "research", "experiment", "marketing"] as const;
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
  /** Where it was started. "linear": the R5 Linear integration, since removed (R7); "ticket": the board. */
  origin: text("origin", { enum: ["dashboard", "discord", "linear", "ticket"] }).notNull().default("dashboard"),
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
}, (t) => [index("mission_messages_idx").on(t.missionId, t.id)]);

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  value: json<Record<string, unknown>>("value").notNull(),
  secretSealed: text("secret_sealed"),
  updatedAt: integer("updated_at").notNull(),
});

// ---- R7: the built-in board ------------------------------------------------------------------
export const TICKET_STATUSES = ["backlog", "todo", "in_progress", "needs_you", "done", "canceled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Where a ticket's work happens: a registered project, a fresh local sandbox, or an idea with no repository yet. */
export const TICKET_SPACES = ["project", "sandbox", "ideas"] as const;

/** Your tasks. One becomes a mission when it starts (todo, a free slot); after that the mission drives its status. */
export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  prefix: text("prefix").notNull(),
  number: integer("number").notNull(),
  space: text("space", { enum: TICKET_SPACES }).notNull(),
  /** The project it belongs to (space "project"), or the local one made for it when it started. */
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  kind: text("kind", { enum: MISSION_KINDS }).notNull(),
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: integer("priority").notNull().default(0),
  status: text("status", { enum: TICKET_STATUSES }).notNull(),
  /** Manual order within a status: smallest first. */
  position: real("position").notNull(),
  missionId: text("mission_id"),
  /** "you", or the agent that filed it from another ticket. */
  createdBy: text("created_by").notNull(),
  fromTicketId: text("from_ticket_id"),
  /** Attachments go into the repository (docs/agentswarm/<task>/request/) when it starts. */
  commitAttachments: integer("commit_attachments", { mode: "boolean" }).notNull().default(true),
  /** Imported from elsewhere (Linear): its old id and link. */
  external: json<{ key: string; url: string }>("external"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
}, (t) => [
  uniqueIndex("tickets_key_uq").on(t.prefix, t.number),
  index("tickets_status_idx").on(t.status, t.position),
  uniqueIndex("tickets_mission_uq").on(t.missionId),
]);

/** What happened to a ticket and who did it: created, edited, moved, started, ended. */
export const ticketEvents = sqliteTable("ticket_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  kind: text("kind", { enum: ["created", "edited", "status", "started", "ended", "attachment", "promoted"] }).notNull(),
  data: json<Record<string, unknown>>("data").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.id)]);

/** Pictures you attach (a bug's screenshot): kept in swarmd's data, given to the lead when the ticket starts. */
export const ticketAttachments = sqliteTable("ticket_attachments", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** The stored file under <data>/attachments/<ticket>/ (always a JPEG). */
  file: text("file").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("ticket_attachments_ticket_idx").on(t.ticketId)]);

// ---- R8: the team's memory -------------------------------------------------------------------
/** What agents are: their handbook and the lessons meant for them. */
export const ROLES = ["lead", "researcher", "architect", "developer", "reviewer", "qa", "marketer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Lessons the team learned: written at retrospectives (by a lead) or by you. Scope: the whole team, one
 * project, or one role. Yours are requirements; an agent's are advice (marked so wherever they appear).
 */
export const lessons = sqliteTable("lessons", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["team", "project", "role"] }).notNull(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  role: text("role", { enum: ROLES }),
  title: text("title").notNull(),
  text: text("text").notNull(),
  /** "you", or the agent that wrote it. */
  author: text("author").notNull(),
  /** The ticket (key) or mission it came from. */
  source: text("source"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  retired: integer("retired", { mode: "boolean" }).notNull().default(false),
  /**
   * "suggested": an agent's lesson for the whole team or a role, shown to nobody until you approve it (a prompt-
   * injected agent must not reach every project). Agents' project lessons, and yours, are "active".
   */
  status: text("status", { enum: ["active", "suggested"] }).notNull().default("active"),
  /** The mission that recorded it (limits per mission). */
  missionId: text("mission_id"),
  uses: integer("uses").notNull().default(0),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("lessons_scope_idx").on(t.scope, t.projectId, t.role)]);

/** Earlier texts of a lesson, and who changed them. */
export const lessonVersions = sqliteTable("lesson_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  text: text("text").notNull(),
  author: text("author").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("lesson_versions_idx").on(t.lessonId, t.id)]);

/** How each role works: Markdown in its prompt. Every change is a version; you edit, agents only propose. */
export const handbooks = sqliteTable("handbooks", {
  role: text("role", { enum: ROLES }).primaryKey(),
  text: text("text").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const handbookVersions = sqliteTable("handbook_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role", { enum: ROLES }).notNull(),
  text: text("text").notNull(),
  author: text("author").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("handbook_versions_idx").on(t.role, t.id)]);

/** A change to a handbook an agent suggested at a retrospective; it waits for you. */
export const handbookProposals = sqliteTable("handbook_proposals", {
  id: text("id").primaryKey(),
  role: text("role", { enum: ROLES }).notNull(),
  change: text("change").notNull(),
  why: text("why").notNull(),
  author: text("author").notNull(),
  source: text("source"),
  status: text("status", { enum: ["open", "accepted", "rejected"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
}, (t) => [index("handbook_proposals_status_idx").on(t.status, t.createdAt)]);

// ---- R9: desktop sessions ----------------------------------------------------------------------
export const DESKTOP_STATUSES = ["queued", "pending", "active", "ended", "denied"] as const;

/**
 * An agent's turn at this Mac's desktop, to test one app. queued: another session has the desktop;
 * pending: waiting for your approval; active: approved, until `until`; ended or denied.
 */
export const desktopSessions = sqliteTable("desktop_sessions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  agent: text("agent").notNull(),
  purpose: text("purpose").notNull(),
  minutes: integer("minutes").notNull(),
  status: text("status", { enum: DESKTOP_STATUSES }).notNull(),
  until: integer("until"),
  endReason: text("end_reason"),
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
  endedAt: integer("ended_at"),
}, (t) => [index("desktop_sessions_status_idx").on(t.status, t.createdAt)]);
