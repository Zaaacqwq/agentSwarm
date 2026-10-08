import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, Server } from "lucide-react";
import type { Agent, Workstation } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, TextInput } from "../../components/ui/Field.tsx";
import { WorkstationDetail } from "./WorkstationDetail.tsx";

export function WorkstationsPage() {
  const { workstationId } = useParams();
  const workstations = useQuery({ queryKey: qk.workstations, queryFn: api.workstations });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const host = useQuery({ queryKey: qk.host, queryFn: api.host });
  const [adding, setAdding] = useState(false);
  const byId = new Map((agents.data ?? []).map((a) => [a.id, a]));
  const selected = workstations.data?.find((w) => w.id === workstationId);

  if (workstationId && selected) return <WorkstationDetail workstation={selected} agents={byId} />;

  return (
    <div className="mx-auto h-full max-w-7xl space-y-4 overflow-y-auto pb-6">
      <header className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h1 className="text-[length:var(--text-display)] leading-tight font-extrabold tracking-tight">Workstations</h1>
          <p className="text-sm text-muted">Each one is its own macOS user. Anyone can read; one agent writes at a time.</p>
        </div>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>Register</Button>
      </header>
      {adding ? <RegisterForm onDone={() => setAdding(false)} /> : null}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(workstations.data ?? []).map((ws, i) => (
          <li key={ws.id} className={i === 0 && (workstations.data?.length ?? 0) > 2 ? "xl:row-span-2" : ""}>
            <WorkstationCard ws={ws} agents={byId} tall={i === 0 && (workstations.data?.length ?? 0) > 2} />
          </li>
        ))}
        {host.data ? (
          <li className="rounded-card border border-line bg-sunken/60 p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-faint">Host</h2>
            <p className="mt-2 text-sm">Memory pressure <strong className={host.data.pressure === "normal" ? "text-ok" : "text-warn"}>{host.data.pressure}</strong> · swap {host.data.swapUsedMb} MB</p>
            <p className="text-sm text-muted">Command slots {host.data.heavyTasks.running}/{host.data.heavyTasks.slots} busy{host.data.heavyTasks.waiting ? ` · ${host.data.heavyTasks.waiting} waiting` : ""}</p>
            <ul className="mt-3 space-y-2">
              {host.data.disks.map((d) => (
                <li key={d.mount} className="text-xs text-muted">
                  <div className="flex justify-between"><span className="font-mono">{d.mount}</span><span>{d.freeGb} GB free</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-honey/80" style={{ width: `${Math.round(100 - (d.freeGb / d.totalGb) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
      {workstations.isSuccess && workstations.data.length === 0 ? (
        <div className="rounded-card border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
          <Server className="mx-auto mb-2 text-faint" size={26} aria-hidden />
          No workstations yet. Run <code className="font-mono text-ink">sudo zsh scripts/setup-workstations.sh</code>, then register <code className="font-mono text-ink">ws-1</code>.
        </div>
      ) : null}
    </div>
  );
}

function WorkstationCard({ ws, agents, tall }: { ws: Workstation; agents: Map<string, Agent>; tall: boolean }) {
  const worktrees = useQuery({ queryKey: qk.worktrees(ws.id), queryFn: () => api.worktrees(ws.id) });
  const holder = ws.writeLease ? agents.get(ws.writeLease.holderAgentId) : undefined;
  return (
    <Link
      to={`/workstations/${ws.id}`}
      className={`group flex h-full flex-col rounded-card border bg-surface/80 p-5 backdrop-blur transition-[border-color,transform] duration-[var(--duration-normal)] ease-[var(--ease-out-expo)] hover:-translate-y-0.5 hover:border-honey/50 ${holder ? "border-honey/40 shadow-glow" : "border-line"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-extrabold tracking-tight">{ws.name}</h2>
          <p className="font-mono text-xs text-faint">{ws.osUser} · {ws.kind}{ws.networkAllowed ? " · net" : ""}</p>
        </div>
        <span className={`flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[0.7rem] font-bold ${holder ? "bg-honey/15 text-honey" : "bg-ok/10 text-ok"}`}>
          {holder ? <Lock size={11} aria-hidden /> : null}
          {holder ? `${holder.name} writing` : "free"}
        </span>
      </div>
      <div className="mt-4 flex -space-x-2">
        {ws.agentIds.map((id) => {
          const a = agents.get(id);
          return a ? <AgentAvatar key={id} seed={a.avatarSeed} state={a.state} size={30} label={a.name} /> : null;
        })}
        {ws.agentIds.length === 0 ? <span className="text-xs text-faint">No agents assigned</span> : null}
      </div>
      <ul className={`mt-4 space-y-1.5 ${tall ? "" : "max-h-24 overflow-hidden"}`}>
        {(worktrees.data ?? []).map((wt) => (
          <li key={wt.id} className="truncate rounded-lg bg-sunken px-2.5 py-1.5 font-mono text-xs text-muted">{wt.branch}</li>
        ))}
        {worktrees.isSuccess && worktrees.data.length === 0 ? <li className="text-xs text-faint">No worktrees yet</li> : null}
      </ul>
    </Link>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("Bench 1");
  const [osUser, setOsUser] = useState("ws-1");
  const create = useMutation({
    mutationFn: () => api.createWorkstation({ name, osUser }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.workstations });
      onDone();
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={onSubmit} className="grid gap-4 rounded-card border border-honey/30 bg-surface/80 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} /></Field>
      <Field label="macOS user"><TextInput value={osUser} onChange={(e) => setOsUser(e.target.value)} required pattern="ws-[0-9]{1,3}" className="font-mono" /></Field>
      <Button type="submit" variant="primary" disabled={create.isPending}>{create.isPending ? "Checking…" : "Register"}</Button>
      <div className="sm:col-span-3"><ErrorNote error={create.error} /></div>
    </form>
  );
}
