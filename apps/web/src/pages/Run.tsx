import { useState } from "react";
import type { RunEventView, RunView } from "@agentswarm/contracts";
import { api, money, when } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Badge, Field, Form, PageHead, RuntimeTag } from "../components/ui.tsx";
import { Tree } from "../components/Tree.tsx";

export function RunPage({ id }: { id: string }) {
  const run = useResource<RunView>(`/runs/${id}`);
  const events = useResource<RunEventView[]>(`/runs/${id}/events`);
  const [text, setText] = useState("");
  useReconnect(() => {
    run.reload();
    events.reload();
  });
  useLive((m) => {
    if (m.kind === "run" && m.run.id === id) run.set(() => m.run);
    if (m.kind === "event" && m.event.runId === id) events.set((prev) => (prev?.some((e) => e.id === m.event.id) ? prev : [...(prev ?? []), m.event]));
  });
  if (!run.data) return run.error ? <p className="error">{run.error}</p> : null;
  const r = run.data;
  const live = r.status === "running" || r.status === "queued" || r.status === "waiting";
  return (
    <div className="stack">
      <PageHead title={r.title} sub={<><Badge status={r.status} /> <RuntimeTag runtime={r.runtime} /> <span className="mono">{r.branch}</span>{r.workstationId && <> · {r.workstationId}</>}</>}
        action={live ? <button className="btn ghost" onClick={() => api("POST", `/runs/${id}/cancel`, {}).catch((e: Error) => alert(e.message))}>Cancel</button> : undefined} />
      <div className="row" style={{ gap: "var(--space-8)" }}>
        <div className="stat"><b>{r.turns}</b><span>Turns</span></div>
        {r.runtime === "native"
          ? <div className="stat"><b>{money(r.costUsd)}</b><span>Cost</span></div>
          : <div className="stat"><b>≈{money(r.estimatedUsd)}</b><span>At API prices (subscription)</span></div>}
        <div className="stat"><b>{(r.tokensIn / 1000).toFixed(1)}k / {(r.tokensOut / 1000).toFixed(1)}k</b><span>Tokens in / out</span></div>
        <div className="stat"><b>{when(r.startedAt)}</b><span>Started</span></div>
      </div>
      {r.error && <div className="card error" role="alert">{r.error}</div>}
      {r.prUrl && <div className="card">Pull request: <a href={r.prUrl} target="_blank" rel="noreferrer">{r.prUrl}</a></div>}
      {r.treeId && <Tree treeId={r.treeId} current={r.id} />}
      {r.report && (
        <section className="card" aria-labelledby="report">
          <h2 id="report">Report</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{r.report.summary}</p>
          <p className="faint">Tests: {r.report.tests}</p>
          {r.report.unfinished.length > 0 && <ul>{r.report.unfinished.map((u) => <li key={u}>{u}</li>)}</ul>}
        </section>
      )}
      <section aria-label="Timeline" className="timeline">
        {pairTools(events.data ?? []).map((item) => (item.kind === "tool" ? <ToolCall key={item.start.id} start={item.start} end={item.end} /> : <Event key={item.event.id} e={item.event} />))}
      </section>
      <section className="card">
        <Form submit={live ? "Send to the agent" : "Continue this run"} onSubmit={async () => {
          await api("POST", `/runs/${id}/messages`, { text });
          setText("");
        }}>
          <Field label="Message"><textarea value={text} onChange={(e) => setText(e.target.value)} required style={{ minHeight: 80 }} /></Field>
        </Form>
      </section>
    </div>
  );
}

type Item = { kind: "tool"; start: RunEventView; end: RunEventView | undefined } | { kind: "event"; event: RunEventView };

/** One card per tool call: its start, and its result once it arrives. */
function pairTools(events: RunEventView[]): Item[] {
  const ends = new Map(events.filter((e) => e.type === "tool_end").map((e) => [String(e.data.id), e]));
  return events.filter((e) => e.type !== "tool_end").map((e) => (e.type === "tool_start" ? { kind: "tool", start: e, end: ends.get(String(e.data.id)) } : { kind: "event", event: e }));
}

function ToolCall({ start, end }: { start: RunEventView; end: RunEventView | undefined }) {
  const s = start.data as Record<string, any>;
  const d = end?.data as Record<string, any> | undefined;
  const mark = !d ? "…" : d.isError ? "✕" : "✓";
  return (
    <div className={`event tool${d?.isError ? " err" : ""}`}>
      <div className="who">{mark} {s.name}{d?.ms ? ` · ${(d.ms / 1000).toFixed(1)} s` : ""}</div>
      <pre>{summarize(s.args)}</pre>
      {d && (
        <details open={d.isError}>
          <summary className="faint">{d.isError ? "Error" : "Result"}</summary>
          <pre>{d.output}</pre>
        </details>
      )}
    </div>
  );
}

function Event({ e }: { e: RunEventView }) {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case "user":
      return <div className="event user"><div className="who">You</div><pre>{d.text}</pre></div>;
    case "assistant":
      return <div className={`event assistant${d.error ? " error" : ""}`}><div className="who">Agent</div><pre>{d.text || d.error}</pre></div>;
    case "push":
      return <div className={`event push${d.status === "pushed" ? "" : " error"}`}><div className="who">Relay · <Badge status={d.status} /></div><pre>{d.branch}{d.headSha ? ` @ ${String(d.headSha).slice(0, 10)}` : ""}{d.reason ? `\n${d.reason}` : ""}</pre></div>;
    case "results":
      return <div className="event results"><div className="who">Sub-agents reported</div><pre>{d.text}</pre></div>;
    case "error":
      return <div className="event error"><div className="who">Problem</div><pre>{d.message}</pre></div>;
    default:
      return <div className="status-line faint">{statusText(d)}</div>;
  }
}

function statusText(d: Record<string, any>): string {
  if (d.status === "running") return `Started on ${d.workstation}`;
  if (d.status === "worktree") return `Worktree ready: ${d.branch} from ${d.base}`;
  if (d.status === "spawned") return `Spawned ${d.name} on ${d.branch}`;
  if (d.status === "waiting") return `Waiting for ${d.for?.length ?? 0} sub-agent${d.for?.length === 1 ? "" : "s"}; workstation released`;
  if (d.status === "pull_request") return `Opened pull request ${d.url}`;
  if (d.status === "cli") return `${d.runtime === "codex" ? "Codex" : "Claude Code"} session ${String(d.session ?? "").slice(0, 8)}${d.model ? ` · ${d.model}` : ""}`;
  if (d.status === "committed") return "agentSwarm committed what the CLI left uncommitted";
  return `Run ${d.status}${d.error ? `: ${d.error}` : ""}`;
}

function summarize(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? (v.length > 400 ? `${v.slice(0, 400)}…` : v) : JSON.stringify(v)}`).join("\n");
}
