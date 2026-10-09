import type { TaskStatus } from "@hive/core";

export type TaskActor = "user" | "assignee" | "lead" | "reviewer" | "system";

/**
 * Who may move a task between which states. People may do anything sensible from the board;
 * agents are limited to their role, and only people (or a merged PR) can finish a task.
 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, readonly TaskActor[]>>> = {
  backlog: { todo: ["user"], blocked: ["user"] },
  todo: { in_progress: ["user", "assignee", "lead", "system"], blocked: ["user", "assignee", "lead"], backlog: ["user"] },
  in_progress: { in_review: ["user", "assignee", "system"], blocked: ["user", "assignee", "lead", "system"], todo: ["user", "lead"], done: ["user"] },
  in_review: { in_progress: ["user", "reviewer", "lead", "system"], done: ["user", "system"], blocked: ["user", "lead", "system"] },
  blocked: { in_progress: ["user", "assignee", "lead"], todo: ["user", "lead"], in_review: ["user", "system"] },
  done: { in_progress: ["user"] },
};

export function canTransition(from: TaskStatus, to: TaskStatus, actor: TaskActor): boolean {
  if (from === to) return true;
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export function allowedTargets(from: TaskStatus, actor: TaskActor): TaskStatus[] {
  return (Object.entries(TRANSITIONS[from]) as [TaskStatus, readonly TaskActor[]][]).filter(([, who]) => who.includes(actor)).map(([to]) => to);
}

/** The six sections HIVE_PLAN §8.4 requires in every handoff note. */
export const HANDOFF_SECTIONS = [
  { key: "background", labels: ["背景", "background", "context"] },
  { key: "done", labels: ["已完成", "done", "completed"] },
  { key: "next", labels: ["未完成与下一步", "未完成", "next steps", "remaining", "todo"] },
  { key: "branch", labels: ["分支与状态", "分支", "branch", "state"] },
  { key: "verify", labels: ["如何验证", "验证", "how to verify", "verify", "testing"] },
  { key: "caveats", labels: ["注意事项", "注意", "caveats", "notes", "risks"] },
] as const;

/** Returns the names of missing sections; a section counts when a heading or "label:" line names it and has text. */
export function missingHandoffSections(notes: string): string[] {
  const lines = notes.split("\n").map((l) => l.trim().toLowerCase().replace(/^#+\s*|^[-*]\s*|\*\*/g, ""));
  const missing: string[] = [];
  for (const section of HANDOFF_SECTIONS) {
    const index = lines.findIndex((l) => section.labels.some((label) => l.startsWith(label.toLowerCase())));
    if (index < 0) {
      missing.push(section.labels[0]);
      continue;
    }
    const label = section.labels.find((l) => lines[index]!.startsWith(l.toLowerCase()))!;
    // Only text after the label (and an optional colon) counts as the section's body.
    const sameLine = lines[index]!.slice(label.length).replace(/^\s*[:：]?\s*/, "").trim();
    const nextLine = lines[index + 1] ?? "";
    const hasBody = sameLine.length > 0 || (nextLine.length > 0 && !HANDOFF_SECTIONS.some((s) => s.labels.some((l) => nextLine.startsWith(l.toLowerCase()))));
    if (!hasBody) missing.push(section.labels[0]);
  }
  return missing;
}

/** Branch-safe slug from a task title, e.g. "Add jitter to backoff!" -> "add-jitter-to-backoff". */
export function taskSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "work";
}
