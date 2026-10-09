import { Type } from "typebox";
import { defineHiveTool, type AnyHiveTool, type Toolpack, type ToolResult } from "../toolpack.ts";
import type { TaskPort, TaskView } from "./task-port.ts";

export const TASKS_PACK_ID = "core.tasks";
const MAX_TEXT = 8000;

const GUIDANCE = [
  "Tasks: work is tracked as tasks T-<n> with a status, an assignee, a reviewer and their own task channel.",
  "Leads: task_create proposals wait for a person's approval; only then task_assign them (with a reviewer).",
  "Developers: task_start opens the task branch on your workstation; finish with git_push and pr_create (that moves the task to review).",
  "Reviewers: pr_view, comment with pr_comment, then task_review approve or request_changes. People merge; never claim a task is done.",
  "Handoffs (task_handoff) must include: 背景/Background, 已完成/Done, 未完成与下一步/Next steps, 分支与状态/Branch, 如何验证/How to verify, 注意事项/Caveats.",
].join("\n");

const Ref = Type.String({ minLength: 1, maxLength: 40, description: "Task reference, e.g. T-12 or 12" });
const Status = Type.Union(["backlog", "todo", "in_progress", "in_review", "done", "blocked"].map((s) => Type.Literal(s)));

async function attempt(work: () => Promise<string> | string): Promise<ToolResult> {
  try {
    const text = await work();
    return { text: text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n… [truncated]` };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function line(t: TaskView): string {
  const who = t.assignee ? ` · ${t.assignee}` : "";
  const pr = t.prUrl ? ` · ${t.prUrl}` : "";
  return `${t.ref} [${t.status}${t.approved ? "" : ", awaiting approval"}] ${t.title}${who}${pr}`;
}

function full(t: TaskView): string {
  return [
    line(t),
    t.description,
    t.acceptance.length ? `Acceptance:\n${t.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    t.dependsOn.length ? `Depends on: ${t.dependsOn.join(", ")}` : "",
    `Reviewer: ${t.reviewer ?? "none"} · Branch: ${t.branch ?? "not started"} · Channel: ${t.channelId ?? "-"} · Spent: $${t.spentUsd.toFixed(4)}`,
  ].filter(Boolean).join("\n");
}

export function createTasksPack(port: TaskPort): Toolpack {
  const tools: AnyHiveTool[] = [
    defineHiveTool({
      name: "task_list", label: "List tasks", access: "r",
      description: "List tasks, optionally by status or only those assigned to or reviewed by you.",
      parameters: Type.Object({ status: Type.Optional(Status), mine: Type.Optional(Type.Boolean()) }),
      execute: (ctx, p) => attempt(() => {
        const list = port.listFor(ctx, { ...(p.status ? { status: p.status as TaskView["status"] } : {}), ...(p.mine ? { mine: true } : {}) });
        return list.length ? list.map(line).join("\n") : "No tasks.";
      }),
    }),
    defineHiveTool({
      name: "task_get", label: "Task details", access: "r",
      description: "Show a task's description, acceptance criteria, dependencies, branch, PR and history.",
      parameters: Type.Object({ task: Ref }),
      execute: (ctx, p) => attempt(() => {
        const { task, history } = port.getFor(ctx, p.task);
        return `${full(task)}\n\nHistory:\n${history.slice(-15).join("\n")}`;
      }),
    }),
    defineHiveTool({
      name: "task_create", label: "Create task", access: "w",
      description: "Propose a task. It waits in the backlog until a person approves it.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 140 }),
        description: Type.String({ maxLength: 8000 }),
        acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20, description: "Checkable acceptance criteria" }),
        depends_on: Type.Optional(Type.Array(Ref, { maxItems: 20 })),
        repo: Type.Optional(Type.String({ description: "Repository name, e.g. hive-sandbox" })),
      }),
      execute: (ctx, p) => attempt(() => `Created ${line(port.createFor(ctx, { title: p.title, description: p.description, acceptance: p.acceptance, dependsOn: p.depends_on ?? [], ...(p.repo ? { repo: p.repo } : {}) }))}`),
    }),
    defineHiveTool({
      name: "task_assign", label: "Assign task", access: "w",
      description: "Assign an approved task to a developer (and optionally a reviewer). Wakes the developer.",
      parameters: Type.Object({ task: Ref, agent: Type.String(), reviewer: Type.Optional(Type.String()) }),
      execute: (ctx, p) => attempt(() => `Assigned ${line(port.assignFor(ctx, p.task, p.agent, p.reviewer))}`),
    }),
    defineHiveTool({
      name: "task_start", label: "Start task", access: "w",
      description: "Start (or resume) your assigned task: opens its branch on your workstation and makes it your active worktree.",
      parameters: Type.Object({ task: Ref }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.startFor(ctx, p.task);
        return `${r.created ? "Started" : "Resumed"} ${r.task.ref} on ${r.branch}. Workstation tools now work in this task's worktree.\n\n${full(r.task)}`;
      }),
    }),
    defineHiveTool({
      name: "task_update", label: "Update task", access: "w",
      description: "Change a task's status within your role (e.g. blocked, back to in_progress) and/or add a note.",
      parameters: Type.Object({ task: Ref, status: Type.Optional(Status), note: Type.Optional(Type.String({ maxLength: 2000 })) }),
      execute: (ctx, p) => attempt(() => `Updated ${line(port.updateFor(ctx, p.task, p.status as TaskView["status"] | undefined, p.note))}`),
    }),
    defineHiveTool({
      name: "task_comment", label: "Comment on task", access: "w",
      description: "Post in the task's channel (use @Name to wake someone).",
      parameters: Type.Object({ task: Ref, body: Type.String({ minLength: 1, maxLength: 8000 }) }),
      execute: (ctx, p) => attempt(() => {
        port.commentFor(ctx, p.task, p.body);
        return "Comment posted.";
      }),
    }),
    defineHiveTool({
      name: "task_handoff", label: "Hand off task", access: "w",
      description: "Hand the task to another agent. Your work is pushed as WIP first. Notes must cover all six handoff sections.",
      parameters: Type.Object({ task: Ref, to: Type.String(), notes: Type.String({ minLength: 20, maxLength: 8000 }) }),
      execute: (ctx, p) => attempt(async () => `Handed off ${line(await port.handoffFor(ctx, p.task, p.to, p.notes))}`),
    }),
    defineHiveTool({
      name: "task_review", label: "Review task", access: "w",
      description: "As the reviewer, approve the task's PR or request changes (sends it back to the developer).",
      parameters: Type.Object({ task: Ref, decision: Type.Union([Type.Literal("approve"), Type.Literal("request_changes")]), notes: Type.String({ minLength: 1, maxLength: 8000 }) }),
      execute: (ctx, p) => attempt(() => `Review recorded: ${line(port.reviewFor(ctx, p.task, p.decision, p.notes))}`),
    }),
    defineHiveTool({
      name: "pr_view", label: "View PR", access: "r",
      description: "Show the task's pull request: files changed, checks and the (truncated) diff.",
      parameters: Type.Object({ task: Ref }),
      execute: (ctx, p) => attempt(() => port.prViewFor(ctx, p.task)),
    }),
    defineHiveTool({
      name: "pr_comment", label: "Comment on PR", access: "w",
      description: "Comment on the task's pull request on GitHub.",
      parameters: Type.Object({ task: Ref, body: Type.String({ minLength: 1, maxLength: 8000 }) }),
      execute: (ctx, p) => attempt(async () => {
        await port.prCommentFor(ctx, p.task, p.body);
        return "PR comment posted.";
      }),
    }),
  ];
  return { id: TASKS_PACK_ID, label: "Tasks", tools: () => tools, healthcheck: async () => ({ available: true }), guidance: GUIDANCE };
}
