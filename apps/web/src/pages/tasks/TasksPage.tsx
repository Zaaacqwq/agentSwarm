import { useMemo, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitPullRequest, Link2, Plus } from "lucide-react";
import type { Agent, Task, TaskStatus } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote } from "../../components/ui/Field.tsx";
import { usd } from "../../lib/format.ts";
import { NewTaskDialog } from "./NewTaskDialog.tsx";
import { TaskDrawer } from "./TaskDrawer.tsx";

export const COLUMNS: { status: TaskStatus; label: string; accent: string }[] = [
  { status: "backlog", label: "Backlog", accent: "var(--color-faint)" },
  { status: "todo", label: "To do", accent: "var(--color-info)" },
  { status: "in_progress", label: "In progress", accent: "var(--color-honey)" },
  { status: "in_review", label: "In review", accent: "oklch(72% 0.14 300)" },
  { status: "blocked", label: "Blocked", accent: "var(--color-err)" },
  { status: "done", label: "Done", accent: "var(--color-ok)" },
];

export function TasksPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const tasks = useQuery({ queryKey: qk.tasks, queryFn: api.tasks });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const byAgent = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data]);
  const byId = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) => api.updateTask(id, { status }),
    onSuccess: (t) => client.setQueryData<Task[]>(qk.tasks, (list) => list?.map((x) => (x.id === t.id ? t : x))),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.approveTask(id),
    onSuccess: (t) => client.setQueryData<Task[]>(qk.tasks, (list) => list?.map((x) => (x.id === t.id ? t : x))),
  });

  const onDrop = (status: TaskStatus) => (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/task-id");
    const task = byId.get(id);
    setDragging(null);
    if (task && task.status !== status) move.mutate({ id, status });
  };

  const selected = taskId ? byId.get(taskId) : undefined;

  return (
    <div className="mx-auto flex h-full max-w-[110rem] flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h1 className="text-[length:var(--text-display)] leading-tight font-extrabold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted">Agents propose into the backlog; you approve. Drag cards to change status. Only people merge.</p>
        </div>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New task</Button>
      </header>
      <ErrorNote error={move.error ?? approve.error} />
      {creating ? <NewTaskDialog onClose={() => setCreating(false)} /> : null}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {COLUMNS.map((col) => {
          const list = (tasks.data ?? []).filter((t) => t.status === col.status);
          return (
            <section
              key={col.status}
              aria-label={col.label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop(col.status)}
              className={`flex min-w-56 flex-1 basis-0 flex-col rounded-card border bg-surface/70 backdrop-blur transition-colors ${dragging ? "border-dashed border-line-strong" : "border-line"}`}
            >
              <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-bold">
                <span className="size-2 rounded-full" style={{ background: col.accent }} aria-hidden />
                {col.label}
                <span className="ml-auto rounded-pill bg-sunken px-2 text-xs text-muted">{list.length}</span>
              </h2>
              <ol className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} agents={byAgent} tasks={byId} accent={col.accent}
                    onDragStart={(e) => { e.dataTransfer.setData("text/task-id", t.id); setDragging(t.id); }}
                    onDragEnd={() => setDragging(null)}
                    onApprove={() => approve.mutate(t.id)} />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
      {selected ? <TaskDrawer task={selected} onClose={() => void navigate("/tasks")} /> : null}
    </div>
  );
}

function TaskCard({ task: t, agents, tasks, accent, onDragStart, onDragEnd, onApprove }: {
  task: Task; agents: Map<string, Agent>; tasks: Map<string, Task>; accent: string;
  onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onApprove: () => void;
}) {
  const assignee = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
  const openDeps = t.dependsOn.map((id) => tasks.get(id)).filter((d): d is Task => !!d && d.status !== "done");
  return (
    <li draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      className="group relative cursor-grab rounded-2xl border border-line bg-raised/80 shadow-lift transition-[transform,border-color] duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:border-line-strong active:cursor-grabbing">
      <span className="absolute inset-y-3 left-0 w-0.5 rounded-full" style={{ background: accent }} aria-hidden />
      <Link to={`/tasks/${t.id}`} className="block space-y-2 px-3.5 py-3" draggable={false}>
        <span className="flex items-center gap-2 font-mono text-[0.7rem] text-faint">
          T-{t.number}
          {openDeps.length ? <span className="flex items-center gap-0.5 text-warn" title={`Waiting on ${openDeps.map((d) => `T-${d.number}`).join(", ")}`}><Link2 size={11} aria-hidden />{openDeps.map((d) => `T-${d.number}`).join(" ")}</span> : null}
          {t.prUrl ? <span className={`ml-auto flex items-center gap-0.5 ${t.prState === "checks_failed" ? "text-err" : "text-muted"}`}><GitPullRequest size={11} aria-hidden />{t.prState}</span> : null}
        </span>
        <span className="block text-sm leading-snug font-semibold">{t.title}</span>
        <span className="flex items-center gap-2 text-xs text-muted">
          {assignee ? <><AgentAvatar seed={assignee.avatarSeed} state={assignee.state} size={20} label={assignee.name} />{assignee.name}</> : <span className="text-faint">Unassigned</span>}
          <span className="ml-auto font-mono">{t.budgetUsd ? `${usd(t.spentUsd)} / ${usd(t.budgetUsd)}` : usd(t.spentUsd)}</span>
        </span>
      </Link>
      {!t.approved ? (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3.5 py-2 text-xs">
          <span className="text-muted">Proposed by {t.createdBy.name}</span>
          <button type="button" onClick={onApprove} className="flex items-center gap-1 rounded-pill bg-honey px-2.5 py-1 font-bold text-honey-ink transition-transform active:translate-y-px">
            <Check size={12} strokeWidth={3} /> Approve
          </button>
        </div>
      ) : null}
    </li>
  );
}
