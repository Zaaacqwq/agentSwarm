import { Type, type Static } from "typebox";

export const TaskStatus = Type.Union([
  Type.Literal("backlog"), Type.Literal("todo"), Type.Literal("in_progress"),
  Type.Literal("in_review"), Type.Literal("done"), Type.Literal("blocked"),
]);
export type TaskStatus = Static<typeof TaskStatus>;

export const PrState = Type.Union([Type.Literal("open"), Type.Literal("merged"), Type.Literal("closed"), Type.Literal("checks_failed")]);

export const Task = Type.Object({
  id: Type.String(),
  number: Type.Number(),
  title: Type.String(),
  description: Type.String(),
  acceptance: Type.Array(Type.String()),
  status: TaskStatus,
  assigneeAgentId: Type.Union([Type.String(), Type.Null()]),
  reviewerAgentId: Type.Union([Type.String(), Type.Null()]),
  createdBy: Type.Object({ kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]), id: Type.String(), name: Type.String() }),
  repositoryId: Type.Union([Type.String(), Type.Null()]),
  branch: Type.Union([Type.String(), Type.Null()]),
  channelId: Type.Union([Type.String(), Type.Null()]),
  prUrl: Type.Union([Type.String(), Type.Null()]),
  prState: Type.Union([PrState, Type.Null()]),
  budgetUsd: Type.Union([Type.Number(), Type.Null()]),
  spentUsd: Type.Number(),
  dependsOn: Type.Array(Type.String()),
  approved: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Task = Static<typeof Task>;

export const TaskEvent = Type.Object({
  id: Type.Number(),
  taskId: Type.String(),
  actorKind: Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("system")]),
  actorName: Type.String(),
  kind: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.Number(),
});
export type TaskEvent = Static<typeof TaskEvent>;

const Title = Type.String({ minLength: 1, maxLength: 140 });
const Acceptance = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 });

export const CreateTask = Type.Object(
  {
    title: Title,
    description: Type.String({ maxLength: 20000 }),
    acceptance: Type.Optional(Acceptance),
    repositoryId: Type.Optional(Type.String()),
    dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    assigneeAgentId: Type.Optional(Type.String()),
    reviewerAgentId: Type.Optional(Type.String()),
    budgetUsd: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1000 })),
  },
  { additionalProperties: false },
);
export type CreateTask = Static<typeof CreateTask>;

export const UpdateTask = Type.Object(
  {
    title: Type.Optional(Title),
    description: Type.Optional(Type.String({ maxLength: 20000 })),
    acceptance: Type.Optional(Acceptance),
    status: Type.Optional(TaskStatus),
    assigneeAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    reviewerAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    budgetUsd: Type.Optional(Type.Union([Type.Number({ minimum: 0.01, maximum: 1000 }), Type.Null()])),
    dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    repositoryId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type UpdateTask = Static<typeof UpdateTask>;

export const TaskDetail = Type.Object({ task: Task, events: Type.Array(TaskEvent) });
export type TaskDetail = Static<typeof TaskDetail>;

export const Attachment = Type.Object({
  id: Type.String(),
  channelId: Type.String(),
  messageId: Type.Union([Type.Number(), Type.Null()]),
  filename: Type.String(),
  mime: Type.String(),
  size: Type.Number(),
  createdAt: Type.Number(),
});
export type Attachment = Static<typeof Attachment>;

/** Starting points for new agents; every grant can still be edited afterwards. */
export const ROLE_TEMPLATES = {
  lead: {
    label: "Lead",
    role: "Lead",
    instructions:
      "You break requests into tasks, assign them and follow up. You do not write code.\n" +
      "Create tasks with clear acceptance criteria and dependencies, then list the plan in the chat and @mention the person to approve it.\n" +
      "After approval, assign each task to a developer (and a reviewer). Keep updates short.",
    grants: [
      { toolpackId: "core.communication", toolName: "*" },
      { toolpackId: "core.colleagues", toolName: "*" },
      { toolpackId: "core.tasks", toolName: "task_list" },
      { toolpackId: "core.tasks", toolName: "task_get" },
      { toolpackId: "core.tasks", toolName: "task_create" },
      { toolpackId: "core.tasks", toolName: "task_assign" },
      { toolpackId: "core.tasks", toolName: "task_update" },
      { toolpackId: "core.tasks", toolName: "task_comment" },
      { toolpackId: "core.tasks", toolName: "task_handoff" },
    ],
  },
  dev: {
    label: "Developer",
    role: "Developer",
    instructions:
      "You implement assigned tasks. Start with task_start, read the code, make the change, run the tests,\n" +
      "then git_commit, git_push and pr_create. Report blockers in the task channel instead of guessing.",
    grants: [
      { toolpackId: "core.communication", toolName: "*" },
      { toolpackId: "core.colleagues", toolName: "*" },
      { toolpackId: "core.tasks", toolName: "task_list" },
      { toolpackId: "core.tasks", toolName: "task_get" },
      { toolpackId: "core.tasks", toolName: "task_start" },
      { toolpackId: "core.tasks", toolName: "task_update" },
      { toolpackId: "core.tasks", toolName: "task_comment" },
      { toolpackId: "core.tasks", toolName: "task_handoff" },
      { toolpackId: "core.tasks", toolName: "pr_view" },
      { toolpackId: "core.workstation", toolName: "*" },
    ],
  },
  reviewer: {
    label: "Reviewer",
    role: "Reviewer",
    instructions:
      "You review pull requests against the task's acceptance criteria. Read the diff with pr_view,\n" +
      "comment on the PR with specifics, then record task_review: approve or request_changes. You do not write code.",
    grants: [
      { toolpackId: "core.communication", toolName: "*" },
      { toolpackId: "core.colleagues", toolName: "*" },
      { toolpackId: "core.tasks", toolName: "task_list" },
      { toolpackId: "core.tasks", toolName: "task_get" },
      { toolpackId: "core.tasks", toolName: "task_comment" },
      { toolpackId: "core.tasks", toolName: "task_review" },
      { toolpackId: "core.tasks", toolName: "pr_view" },
      { toolpackId: "core.tasks", toolName: "pr_comment" },
    ],
  },
} as const;
export type RoleTemplateId = keyof typeof ROLE_TEMPLATES;
