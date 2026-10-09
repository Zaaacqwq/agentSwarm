import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, GitBranch, X } from "lucide-react";
import type { Task, TaskStatus, UpdateTask } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, Select, TextArea, TextInput } from "../../components/ui/Field.tsx";
import { clockTime, usd } from "../../lib/format.ts";
import { Conversation } from "../chat/Conversation.tsx";
import { COLUMNS } from "./TasksPage.tsx";

export function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: qk.task(task.id), queryFn: () => api.task(task.id) });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const tasks = useQuery({ queryKey: qk.tasks, queryFn: api.tasks });
  const repos = useQuery({ queryKey: qk.repositories, queryFn: api.repositories });
  const [draft, setDraft] = useState(() => toDraft(task));
  useEffect(() => setDraft(toDraft(task)), [task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = (t: Task) => {
    client.setQueryData<Task[]>(qk.tasks, (list) => list?.map((x) => (x.id === t.id ? t : x)));
    void client.invalidateQueries({ queryKey: qk.task(t.id) });
  };
  const save = useMutation({ mutationFn: (patch: UpdateTask) => api.updateTask(task.id, patch), onSuccess: apply });
  const approve = useMutation({ mutationFn: () => api.approveTask(task.id), onSuccess: apply });

  /** Sends only what the person changed, so live updates from agents are never reverted. */
  const submit = () => {
    const base = toDraft(task);
    const patch: UpdateTask = {};
    if (draft.title !== base.title) patch.title = draft.title;
    if (draft.description !== base.description) patch.description = draft.description;
    if (draft.acceptance !== base.acceptance) patch.acceptance = draft.acceptance.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
    if (draft.assignee !== base.assignee) patch.assigneeAgentId = draft.assignee || null;
    if (draft.reviewer !== base.reviewer) patch.reviewerAgentId = draft.reviewer || null;
    if (draft.repo !== base.repo) patch.repositoryId = draft.repo || null;
    if (draft.budget !== base.budget) patch.budgetUsd = draft.budget.trim() ? Number(draft.budget) : null;
    if (draft.dependsOn.join() !== base.dependsOn.join()) patch.dependsOn = draft.dependsOn;
    if (Object.keys(patch).length) save.mutate(patch);
  };

  const others = (tasks.data ?? []).filter((t) => t.id !== task.id);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <aside role="dialog" aria-label={`T-${task.number} ${task.title}`} onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[min(64rem,100vw)] flex-col overflow-y-auto border-l border-line bg-surface shadow-lift lg:flex-row lg:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
          <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface/95 px-5 py-4 backdrop-blur">
            <span className="font-mono text-sm text-faint">T-{task.number}</span>
            <Select aria-label="Status" value={task.status} className="!h-8 !w-40" onChange={(e) => save.mutate({ status: e.target.value as TaskStatus })}>
              {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
            </Select>
            {!task.approved ? <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => approve.mutate()}>Approve</Button> : null}
            <span className="ml-auto font-mono text-xs text-muted">{task.budgetUsd ? `${usd(task.spentUsd)} of ${usd(task.budgetUsd)}` : `${usd(task.spentUsd)} spent`}</span>
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-raised hover:text-ink" aria-label="Close"><X size={16} /></button>
          </header>
          <div className="space-y-4 px-5 py-5">
            <ErrorNote error={save.error ?? approve.error} />
            <Field label="Title"><TextInput value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={140} /></Field>
            <Field label="Description"><TextArea rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
            <Field label="Acceptance criteria" hint="One per line."><TextArea rows={3} value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Assignee">
                <Select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}>
                  <option value="">Unassigned</option>
                  {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </Field>
              <Field label="Reviewer">
                <Select value={draft.reviewer} onChange={(e) => setDraft({ ...draft, reviewer: e.target.value })}>
                  <option value="">None</option>
                  {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </Field>
              <Field label="Repository">
                <Select value={draft.repo} onChange={(e) => setDraft({ ...draft, repo: e.target.value })}>
                  <option value="">Default</option>
                  {(repos.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </Field>
              <Field label="Budget (USD)" hint="Optional. Empty means no cap.">
                <TextInput inputMode="decimal" value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: e.target.value })} placeholder="no cap" />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted">Depends on</legend>
              <div className="flex flex-wrap gap-1.5">
                {others.map((o) => {
                  const on = draft.dependsOn.includes(o.id);
                  return (
                    <button key={o.id} type="button" aria-pressed={on} onClick={() => setDraft({ ...draft, dependsOn: on ? draft.dependsOn.filter((d) => d !== o.id) : [...draft.dependsOn, o.id] })}
                      className={`rounded-pill border px-2.5 py-0.5 font-mono text-xs transition-colors ${on ? "border-honey/60 bg-honey/15 text-ink" : "border-line text-muted hover:border-line-strong"}`}>
                      T-{o.number}
                    </button>
                  );
                })}
                {others.length === 0 ? <span className="text-xs text-faint">No other tasks.</span> : null}
              </div>
            </fieldset>
            <div className="flex justify-end"><Button variant="primary" onClick={submit} disabled={save.isPending}>Save changes</Button></div>

            {task.branch || task.prUrl ? (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-sunken px-4 py-3 text-sm">
                {task.branch ? <span className="flex items-center gap-1.5 font-mono text-xs text-muted"><GitBranch size={13} aria-hidden />{task.branch}</span> : null}
                {task.prUrl ? (
                  <a href={task.prUrl} target="_blank" rel="noreferrer noopener" className="ml-auto flex items-center gap-1 text-honey underline underline-offset-2">
                    Pull request · {task.prState} <ExternalLink size={12} aria-hidden />
                  </a>
                ) : null}
              </div>
            ) : null}

            <section aria-label="History">
              <h3 className="mb-2 text-sm font-extrabold tracking-tight text-honey">History</h3>
              <ol className="space-y-1.5 border-l border-line pl-4">
                {(detail.data?.events ?? []).map((e) => (
                  <li key={e.id} className="relative text-xs text-muted">
                    <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-line-strong" aria-hidden />
                    <span className="text-faint">{clockTime(e.createdAt)}</span> <strong className="text-ink">{e.actorName}</strong> {e.kind.replace(":", " → ")}
                    {typeof e.data.note === "string" ? <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-faint">{e.data.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
        {task.channelId ? (
          <div className="flex h-[36rem] min-w-0 flex-col border-t border-line p-2 lg:h-full lg:w-[26rem] lg:shrink-0 lg:border-t-0 lg:border-l">
            <Conversation channelId={task.channelId} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function toDraft(t: Task) {
  return {
    title: t.title, description: t.description, acceptance: t.acceptance.join("\n"),
    assignee: t.assigneeAgentId ?? "", reviewer: t.reviewerAgentId ?? "", repo: t.repositoryId ?? "",
    budget: t.budgetUsd !== null ? String(t.budgetUsd) : "", dependsOn: t.dependsOn,
  };
}
