import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Every business row carries org_id and owner_user_id so P6 multi-user can scope reads
// without a data migration. P1 only ever writes the default org and the single admin.

const createdAt = () => integer("created_at").notNull();

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username), check("users_role_ck", sql`${t.role} in ('admin','member')`)],
);

export const loginSessions = sqliteTable(
  "login_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [uniqueIndex("login_sessions_token_uq").on(t.tokenHash), index("login_sessions_user_idx").on(t.userId)],
);

export const endpoints = sqliteTable(
  "endpoints",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["openrouter", "openai-compatible"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("endpoints_org_name_uq").on(t.orgId, t.name),
    check("endpoints_kind_ck", sql`${t.kind} in ('openrouter','openai-compatible')`),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    role: text("role").notNull(),
    instructions: text("instructions").notNull(),
    endpointId: text("endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
    modelId: text("model_id").notNull(),
    thinkingLevel: text("thinking_level", { enum: ["off", "low", "medium", "high"] }).notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("agents_org_name_uq").on(t.orgId, t.name),
    check("agents_thinking_ck", sql`${t.thinkingLevel} in ('off','low','medium','high')`),
  ],
);

export const agentToolGrants = sqliteTable(
  "agent_tool_grants",
  {
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toolpackId: text("toolpack_id").notNull(),
    // "*" grants every tool in the pack; otherwise one row per granted tool.
    toolName: text("tool_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolpackId, t.toolName] })],
);

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    // P1 only allows "dm"; P3 widens this check to agent_dm and group.
    kind: text("kind", { enum: ["dm"] }).notNull(),
    // For dm channels this keeps one channel per (user, agent) pair.
    dmKey: text("dm_key"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channels_dm_key_uq").on(t.dmKey), check("channels_kind_ck", sql`${t.kind} in ('dm')`)],
);

export const channelMembers = sqliteTable(
  "channel_members",
  {
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    memberKind: text("member_kind", { enum: ["user", "agent"] }).notNull(),
    memberId: text("member_id").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.memberKind, t.memberId] }),
    index("channel_members_member_idx").on(t.memberKind, t.memberId),
    check("channel_members_kind_ck", sql`${t.memberKind} in ('user','agent')`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ["user", "agent", "system"] }).notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    runId: text("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_channel_idx").on(t.channelId, t.id),
    check("messages_author_ck", sql`${t.authorKind} in ('user','agent','system')`),
  ],
);

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "interrupted"] as const;

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    error: text("error"),
    // Messages this run was woken for; the run delivers all of them at one turn boundary.
    triggerMessageIds: text("trigger_message_ids", { mode: "json" }).$type<number[]>().notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: createdAt(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("runs_agent_idx").on(t.agentId, t.createdAt),
    index("runs_status_idx").on(t.status),
    check("runs_status_ck", sql`${t.status} in ('queued','running','succeeded','failed','interrupted')`),
  ],
);

export const ACTIVITY_KINDS = ["assistant_text", "thinking", "tool_call", "tool_result", "error", "notice"] as const;

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    kind: text("kind", { enum: ACTIVITY_KINDS }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_run_idx").on(t.runId, t.id), index("activity_agent_idx").on(t.agentId, t.id)],
);

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id").notNull().references(() => organizations.id),
    // Usage outlives deleted agents and runs so cost history stays complete.
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    agentId: text("agent_id").notNull(),
    endpointId: text("endpoint_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("usage_agent_idx").on(t.agentId, t.createdAt)],
);

export const agentSessions = sqliteTable("agent_sessions", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  // Pi FileEntry[] (header + entries), rebuilt with SessionManager.inMemory on restart.
  entries: text("entries", { mode: "json" }).$type<unknown[]>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: text("org_id"),
    actorKind: text("actor_kind", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetId: text("target_id"),
    // Field names only; never secret values.
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

// --- P2: workstations, repositories, worktrees, leases, Git Relay -----------------

export const workstations = sqliteTable(
  "workstations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["macos-user", "local-fake"] }).notNull(),
    osUser: text("os_user").notNull(),
    networkAllowed: integer("network_allowed", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("workstations_os_user_uq").on(t.osUser),
    uniqueIndex("workstations_org_name_uq").on(t.orgId, t.name),
    check("workstations_kind_ck", sql`${t.kind} in ('macos-user','local-fake')`),
  ],
);

export const agentWorkstations = sqliteTable(
  "agent_workstations",
  {
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    workstationId: text("workstation_id").notNull().references(() => workstations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.workstationId] })],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    // owner/name on GitHub; PRs are opened here.
    githubFullName: text("github_full_name").notNull(),
    // Where the mirror fetches from and the Relay pushes to.
    remoteUrl: text("remote_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    mirrorName: text("mirror_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repositories_org_name_uq").on(t.orgId, t.name), uniqueIndex("repositories_mirror_uq").on(t.mirrorName)],
);

export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    workstationId: text("workstation_id").notNull().references(() => workstations.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    // Relative to the workstation root, e.g. worktrees/<repo>/<agent>-<slug>
    scope: text("scope").notNull(),
    branch: text("branch").notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at").notNull(),
    removedAt: integer("removed_at"),
  },
  (t) => [
    index("worktrees_agent_idx").on(t.agentId, t.lastUsedAt),
    uniqueIndex("worktrees_live_scope_uq").on(t.workstationId, t.scope).where(sql`removed_at is null`),
  ],
);

export const leases = sqliteTable(
  "leases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["workstation-write"] }).notNull(),
    resourceId: text("resource_id").notNull(),
    holderAgentId: text("holder_agent_id").notNull(),
    runId: text("run_id"),
    acquiredAt: integer("acquired_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    releasedAt: integer("released_at"),
  },
  (t) => [
    uniqueIndex("leases_live_uq").on(t.kind, t.resourceId).where(sql`released_at is null`),
    index("leases_run_idx").on(t.runId),
  ],
);

export const gitPushes = sqliteTable(
  "git_pushes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    worktreeId: text("worktree_id").notNull(),
    agentId: text("agent_id").notNull(),
    branch: text("branch").notNull(),
    headSha: text("head_sha"),
    status: text("status", { enum: ["rejected", "pushed", "failed"] }).notNull(),
    reason: text("reason"),
    prUrl: text("pr_url"),
    createdAt: createdAt(),
  },
  (t) => [index("git_pushes_agent_idx").on(t.agentId, t.createdAt)],
);
