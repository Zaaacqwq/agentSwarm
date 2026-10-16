import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/** One row (id "github"): the token Hive pushes and opens pull requests with. */
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
}, (t) => [uniqueIndex("projects_slug_uq").on(t.slug), uniqueIndex("projects_repo_uq").on(t.githubRepo)]);

export const workstations = sqliteTable("workstations", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["free", "busy", "unhealthy"] }).notNull(),
  runId: text("run_id"),
  lastCheckAt: integer("last_check_at"),
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  endpointId: text("endpoint_id").notNull().references(() => endpoints.id),
  modelId: text("model_id").notNull(),
  instructions: text("instructions").notNull(),
  runtime: text("runtime", { enum: ["native"] }).notNull(),
  // R2: the agent tree.
  parentId: text("parent_id"),
  depth: integer("depth").notNull(),
  budgetUsd: real("budget_usd"),
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
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] }).notNull(),
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
}, (t) => [index("runs_agent_idx").on(t.agentId, t.createdAt), index("runs_status_idx").on(t.status), uniqueIndex("runs_branch_uq").on(t.projectId, t.branch)]);

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
