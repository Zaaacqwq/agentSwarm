import { useState } from "react";
import type { RunEventView, RunView } from "@agentswarm/contracts";
import { api, money, when } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Badge, Field, Form, PageHead, RuntimeTag } from "../components/ui.tsx";
import { Tree } from "../components/Tree.tsx";
import { EventLine, ToolCard, pairTools } from "../components/Activity.tsx";

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
        {pairTools(events.data ?? []).map((item) => (item.kind === "tool" ? <ToolCard key={item.start.id} start={item.start} end={item.end} /> : <EventLine key={item.event.id} e={item.event} />))}
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


