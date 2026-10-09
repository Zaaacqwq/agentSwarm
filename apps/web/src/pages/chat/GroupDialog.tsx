import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Channel } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, TextInput } from "../../components/ui/Field.tsx";

/** Create a group, or edit/delete one when `group` is given. Uses the native <dialog> for focus trapping. */
export function GroupDialog({ group, onClose }: { group?: Channel; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [title, setTitle] = useState(group?.title ?? "");
  const [selected, setSelected] = useState<string[]>(group?.members.filter((m) => m.kind === "agent").map((m) => m.id) ?? []);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const refresh = () => void client.invalidateQueries({ queryKey: qk.channels });
  const save = useMutation({
    mutationFn: () => (group ? api.updateGroup(group.id, { title, agentIds: selected }) : api.createGroup(title, selected)),
    onSuccess: (channel) => {
      refresh();
      onClose();
      if (!group) void navigate(`/chat/${channel.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(group!.id),
    onSuccess: () => {
      refresh();
      onClose();
      void navigate("/chat");
    },
  });

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-lift backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      aria-labelledby="group-dialog-title"
    >
      <form onSubmit={onSubmit} className="space-y-5 p-6">
        <h2 id="group-dialog-title" className="text-xl font-extrabold tracking-tight">{group ? "Edit group" : "New group"}</h2>
        <Field label="Name"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={60} autoFocus placeholder="e.g. Build crew" /></Field>
        <fieldset className="space-y-2">
          <legend className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted">Agents ({selected.length}/16)</legend>
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {(agents.data ?? []).map((a) => (
              <li key={a.id}>
                <label className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${selected.includes(a.id) ? "border-honey/50 bg-honey/5" : "border-line hover:bg-raised/50"}`}>
                  <input type="checkbox" className="size-4 accent-[var(--color-honey)]" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} disabled={!selected.includes(a.id) && selected.length >= 16} />
                  <AgentAvatar seed={a.avatarSeed} size={26} />
                  <span className="flex-1"><span className="font-semibold">{a.name}</span> <span className="text-xs text-muted">{a.role}</span></span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-faint">Agents are woken only when someone @mentions them (or @all).</p>
        </fieldset>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={() => ref.current?.close()}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={save.isPending || !title.trim() || selected.length === 0}>{group ? "Save" : "Create group"}</Button>
        </div>
        {group ? (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-sm text-muted">Delete this group and its history. Type <strong className="text-ink">{group.title}</strong> to confirm.</p>
            <div className="flex gap-2">
              <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Type the group name to confirm" />
              <Button variant="danger" disabled={confirm !== group.title || remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
            </div>
          </div>
        ) : null}
      </form>
    </dialog>
  );
}
