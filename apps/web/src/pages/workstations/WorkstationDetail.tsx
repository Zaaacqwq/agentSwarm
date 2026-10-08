import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, File, Folder, TerminalSquare } from "lucide-react";
import type { Agent, Workstation } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { relativeTime } from "../../lib/format.ts";

export function WorkstationDetail({ workstation: ws, agents }: { workstation: Workstation; agents: Map<string, Agent> }) {
  const worktrees = useQuery({ queryKey: qk.worktrees(ws.id), queryFn: () => api.worktrees(ws.id) });
  const terminals = useQuery({ queryKey: qk.terminals(ws.id), queryFn: () => api.terminals(ws.id), refetchInterval: 5000 });
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const activeWt = worktreeId ?? worktrees.data?.[0]?.id ?? null;
  const activeTerm = terminal ?? terminals.data?.[0]?.name ?? null;
  const holder = ws.writeLease ? agents.get(ws.writeLease.holderAgentId) : undefined;

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface/80 px-5 py-4 backdrop-blur">
        <Link to="/workstations" className="rounded-full p-1 text-muted hover:text-ink" aria-label="All workstations"><ArrowLeft size={18} /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-extrabold tracking-tight">{ws.name}</h1>
          <p className="font-mono text-xs text-faint">{ws.osUser} · {ws.kind}</p>
        </div>
        <span className="text-sm text-muted">
          {holder ? <>Write lease: <strong className="text-honey">{holder.name}</strong> until {new Date(ws.writeLease!.expiresAt).toLocaleTimeString()}</> : "No one is writing"}
        </span>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-card border border-line bg-surface/80 backdrop-blur" aria-labelledby="files-heading">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 id="files-heading" className="text-sm font-bold">Worktrees</h2>
            <select
              className="ml-auto max-w-[70%] truncate rounded-pill border border-line bg-sunken px-3 py-1 font-mono text-xs"
              value={activeWt ?? ""}
              onChange={(e) => setWorktreeId(e.target.value)}
              aria-label="Worktree"
            >
              {(worktrees.data ?? []).map((wt) => (
                <option key={wt.id} value={wt.id}>{wt.branch} · {agents.get(wt.agentId)?.name ?? "agent"} · {relativeTime(wt.lastUsedAt)}</option>
              ))}
            </select>
          </div>
          {activeWt ? <FileBrowser workstationId={ws.id} worktreeId={activeWt} /> : <p className="p-6 text-sm text-muted">No worktrees yet. Agents create them with ws_checkout.</p>}
        </section>

        <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-card border border-line bg-sunken backdrop-blur" aria-labelledby="term-heading">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <TerminalSquare size={15} className="text-honey" aria-hidden />
            <h2 id="term-heading" className="text-sm font-bold">Terminals</h2>
            <div className="ml-auto flex flex-wrap gap-1">
              {(terminals.data ?? []).map((t) => (
                <button key={t.name} type="button" onClick={() => setTerminal(t.name)} className={`rounded-pill px-2.5 py-0.5 font-mono text-xs transition-colors ${t.name === activeTerm ? "bg-honey text-honey-ink" : "text-muted hover:bg-raised"}`}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          {activeTerm ? <TerminalView workstationId={ws.id} name={activeTerm} /> : <p className="p-6 text-sm text-muted">No terminals. Agents open them with term_create.</p>}
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-2 px-1 pb-2 text-xs text-muted">
        Assigned:
        {ws.agentIds.map((id) => {
          const a = agents.get(id);
          return a ? <span key={id} className="flex items-center gap-1.5 rounded-pill border border-line py-0.5 pr-2.5 pl-0.5"><AgentAvatar seed={a.avatarSeed} size={20} />{a.name}</span> : null;
        })}
      </footer>
    </div>
  );
}

function FileBrowser({ workstationId, worktreeId }: { workstationId: string; worktreeId: string }) {
  const [path, setPath] = useState(".");
  const view = useQuery({ queryKey: qk.files(workstationId, worktreeId, path), queryFn: () => api.files(workstationId, worktreeId, path) });
  const crumbs = path === "." ? [] : path.replace(/\/$/, "").split("/");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Path" className="flex flex-wrap items-center gap-1 border-b border-line/60 px-4 py-2 font-mono text-xs">
        <button type="button" className="text-honey hover:underline" onClick={() => setPath(".")}>root</button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1 text-muted">/
            <button type="button" className="hover:text-ink" onClick={() => setPath(`${crumbs.slice(0, i + 1).join("/")}/`)}>{c}</button>
          </span>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">
        {view.data?.kind === "dir" ? (
          <ul className="p-2">
            {view.data.entries.map((e) => (
              <li key={e}>
                <button type="button" onClick={() => setPath(e)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-sm transition-colors hover:bg-raised">
                  {e.endsWith("/") ? <Folder size={14} className="text-honey" aria-hidden /> : <File size={14} className="text-faint" aria-hidden />}
                  {e.split("/").filter(Boolean).pop()}{e.endsWith("/") ? "/" : ""}
                </button>
              </li>
            ))}
          </ul>
        ) : view.data?.kind === "file" ? (
          <FileLines content={view.data.content} fromLine={view.data.fromLine} />
        ) : view.isError ? (
          <p className="p-4 text-sm text-err">{(view.error as Error).message}</p>
        ) : null}
      </div>
    </div>
  );
}

function TerminalView({ workstationId, name }: { workstationId: string; name: string }) {
  const output = useQuery({ queryKey: qk.terminal(workstationId, name), queryFn: () => api.terminal(workstationId, name), refetchInterval: 2000 });
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[0.75rem] leading-snug whitespace-pre-wrap text-ink/90" aria-live="off">
      {output.data?.output || (output.isError ? (output.error as Error).message : "…")}
    </pre>
  );
}

function FileLines({ content, fromLine }: { content: string; fromLine: number }) {
  return (
    <pre className="p-4 font-mono text-[0.78rem] leading-relaxed">
      {content.split("\n").map((line, i) => (
        <div key={i} className="flex gap-4"><span className="w-8 shrink-0 text-right text-faint select-none">{fromLine + i}</span><span className="whitespace-pre-wrap">{line}</span></div>
      ))}
    </pre>
  );
}
