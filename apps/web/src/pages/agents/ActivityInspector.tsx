import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, GitPullRequest } from "lucide-react";
import type { ActivityEvent, Agent, Run } from "@hive/core";
import { Link } from "react-router";
import { api, qk, type RunSource } from "../../app/api.ts";
import { clockTime, tokens, usd } from "../../lib/format.ts";

const STATUS_STYLE: Record<Run["status"], string> = {
  queued: "text-info border-info/40",
  running: "text-honey border-honey/50",
  succeeded: "text-ok border-ok/40",
  failed: "text-err border-err/40",
  interrupted: "text-warn border-warn/40",
};

export function ActivityInspector({ agent }: { agent: Agent }) {
  const runs = useQuery({ queryKey: qk.agentRuns(agent.id), queryFn: () => api.agentRuns(agent.id) });
  const usage = useQuery({ queryKey: qk.agentUsage(agent.id), queryFn: () => api.agentUsage(agent.id) });
  const byRun = groupByRun(runs.data?.activity ?? []);
  const pushes = useQuery({ queryKey: qk.pushes(agent.id), queryFn: () => api.pushes(agent.id) });

  return (
    <aside className="flex min-w-0 flex-col rounded-card border border-line bg-surface/80 backdrop-blur xl:w-[26rem] xl:shrink-0 xl:overflow-hidden">
      <header className="border-b border-line px-5 py-4">
        <h3 className="font-bold">Activity</h3>
        <dl className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Cost" value={usd(usage.data?.costUsd ?? 0)} accent />
          <Stat label="Tokens in" value={tokens(usage.data?.inputTokens ?? 0)} />
          <Stat label="Tokens out" value={tokens(usage.data?.outputTokens ?? 0)} />
        </dl>
        {pushes.data && pushes.data.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {pushes.data.slice(0, 4).map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs">
                <GitPullRequest size={12} className={p.status === "pushed" ? "text-ok" : "text-err"} aria-hidden />
                <span className="truncate font-mono text-muted">{p.branch}</span>
                {p.prUrl ? <a href={p.prUrl} target="_blank" rel="noreferrer noopener" className="ml-auto shrink-0 text-honey underline underline-offset-2">PR</a> : <span className="ml-auto shrink-0 text-faint" title={p.reason ?? ""}>{p.status}</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {(runs.data?.runs ?? []).map((run, i) => (
          <RunCard key={run.id} run={run} events={byRun.get(run.id) ?? []} sources={runs.data?.sources[run.id] ?? []} defaultOpen={i === 0} />
        ))}
        {runs.isSuccess && runs.data.runs.length === 0 ? <li className="px-3 py-8 text-center text-sm text-muted">No runs yet. Message this agent to start one.</li> : null}
      </ol>
    </aside>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-sunken px-3 py-2">
      <dt className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-faint">{label}</dt>
      <dd className={`font-mono text-lg font-semibold ${accent ? "text-honey" : ""}`}>{value}</dd>
    </div>
  );
}

function RunCard({ run, events, sources, defaultOpen }: { run: Run; events: ActivityEvent[]; sources: RunSource[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = run.startedAt && run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : run.status === "running" ? "running" : "—";
  return (
    <li className="overflow-hidden rounded-2xl border border-line bg-sunken/60">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-raised/40" aria-expanded={open}>
        <ChevronRight size={14} className={`shrink-0 text-faint transition-transform duration-[var(--duration-fast)] ${open ? "rotate-90" : ""}`} />
        <span className={`rounded-pill border px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide ${STATUS_STYLE[run.status]}`}>{run.status}</span>
        <span className="text-xs text-muted">{clockTime(run.createdAt)} · {duration}</span>
        <span className="ml-auto font-mono text-xs text-muted">{tokens(run.inputTokens + run.outputTokens)} tok · {usd(run.costUsd)}</span>
      </button>
      {open ? (
        <ol className="space-y-1.5 border-t border-line px-3 py-3">
          {sources.length ? (
            <li className="flex flex-wrap gap-1 text-[0.7rem] text-faint">
              Woken by
              {sources.map((s) => (
                <Link key={s.messageId} to={`/chat/${s.channelId}?m=${s.messageId}`} className="rounded-pill border border-line px-1.5 text-muted hover:border-honey/50 hover:text-ink">
                  {s.authorName}{s.authorKind === "agent" ? " (agent)" : ""} · {s.channelTitle}
                </Link>
              ))}
            </li>
          ) : null}
          {run.error ? <li className="text-xs text-err">{run.error}</li> : null}
          {events.map((e) => <EventRow key={e.id} event={e} />)}
          {events.length === 0 && !run.error ? <li className="text-xs text-faint">No activity recorded.</li> : null}
        </ol>
      ) : null}
    </li>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const p = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "tool_call":
      return (
        <li className="font-mono text-xs">
          <span className="text-honey">→ {String(p.name)}</span>
          <span className="ml-1 break-all text-faint">{JSON.stringify(p.args)}</span>
        </li>
      );
    case "tool_result":
      return (
        <li className={`font-mono text-xs ${p.isError ? "text-err" : "text-muted"}`}>
          <span>← {String(p.name)}</span> <span className="break-words whitespace-pre-wrap">{String(p.text ?? "")}</span>
        </li>
      );
    case "thinking":
      return <li className="border-l-2 border-line pl-2 text-xs whitespace-pre-wrap text-faint italic">{String(p.text)}</li>;
    case "assistant_text":
      return <li className="rounded-lg bg-raised/60 px-2 py-1.5 text-xs whitespace-pre-wrap text-muted"><span className="mr-1 text-[0.6rem] font-bold uppercase text-faint">private</span>{String(p.text)}</li>;
    case "error":
      return <li className="text-xs text-err">{String(p.text)}</li>;
    case "notice":
      return <li className="text-xs text-warn">{String(p.text)}</li>;
  }
}

function groupByRun(events: readonly ActivityEvent[]): Map<string, ActivityEvent[]> {
  const map = new Map<string, ActivityEvent[]>();
  for (const e of events) map.set(e.runId, [...(map.get(e.runId) ?? []), e]);
  return map;
}
