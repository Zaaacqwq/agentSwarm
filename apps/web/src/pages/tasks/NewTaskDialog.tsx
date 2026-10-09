import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../app/api.ts";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, Select, TextArea, TextInput } from "../../components/ui/Field.tsx";

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const repos = useQuery({ queryKey: qk.repositories, queryFn: api.repositories });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [repo, setRepo] = useState("");
  useEffect(() => ref.current?.showModal(), []);

  const create = useMutation({
    mutationFn: () => api.createTask({
      title, description,
      acceptance: acceptance.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean),
      ...(assignee ? { assigneeAgentId: assignee } : {}), ...(reviewer ? { reviewerAgentId: reviewer } : {}), ...(repo ? { repositoryId: repo } : {}),
    }),
    onSuccess: (t) => {
      void client.invalidateQueries({ queryKey: qk.tasks });
      ref.current?.close();
      void navigate(`/tasks/${t.id}`);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="new-task-title" className="m-auto w-[min(38rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-lift backdrop:bg-black/60 backdrop:backdrop-blur-sm">
      <form onSubmit={onSubmit} className="space-y-4 p-6">
        <h2 id="new-task-title" className="text-xl font-extrabold tracking-tight">New task</h2>
        <Field label="Title"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={140} autoFocus /></Field>
        <Field label="Description"><TextArea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} /></Field>
        <Field label="Acceptance criteria" hint="One per line."><TextArea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder={"- tests pass\n- README updated"} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Assignee">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Reviewer">
            <Select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">None</option>
              {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Repository">
            <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Default</option>
              {(repos.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        </div>
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={() => ref.current?.close()}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !title.trim()}>Create task</Button>
        </div>
      </form>
    </dialog>
  );
}
