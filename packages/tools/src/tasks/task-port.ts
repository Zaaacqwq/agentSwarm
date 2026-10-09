import type { AgentContext } from "../toolpack.ts";

export type TaskStatusName = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked";

export interface TaskView {
  readonly ref: string;
  readonly title: string;
  readonly status: TaskStatusName;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly assignee: string | null;
  readonly reviewer: string | null;
  readonly dependsOn: readonly string[];
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly channelId: string | null;
  readonly approved: boolean;
  readonly spentUsd: number;
}

/** What core.tasks needs from hived. Role checks happen there, at execution time. */
export interface TaskPort {
  listFor(ctx: AgentContext, filter: { status?: TaskStatusName; mine?: boolean }): TaskView[];
  getFor(ctx: AgentContext, ref: string): { task: TaskView; history: string[] };
  createFor(ctx: AgentContext, input: { title: string; description: string; acceptance: string[]; dependsOn: string[]; repo?: string }): TaskView;
  assignFor(ctx: AgentContext, ref: string, agent: string, reviewer?: string): TaskView;
  startFor(ctx: AgentContext, ref: string): Promise<{ task: TaskView; branch: string; created: boolean }>;
  updateFor(ctx: AgentContext, ref: string, status: TaskStatusName | undefined, note: string | undefined): TaskView;
  commentFor(ctx: AgentContext, ref: string, body: string): void;
  handoffFor(ctx: AgentContext, ref: string, to: string, notes: string): Promise<TaskView>;
  reviewFor(ctx: AgentContext, ref: string, decision: "approve" | "request_changes", notes: string): TaskView;
  prViewFor(ctx: AgentContext, ref: string): Promise<string>;
  prCommentFor(ctx: AgentContext, ref: string, body: string): Promise<void>;
}
