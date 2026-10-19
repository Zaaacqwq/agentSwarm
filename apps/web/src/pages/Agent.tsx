import { useState } from "react";
import type { AgentView, ProjectView, RunView } from "@agentswarm/contracts";
import { api, ago, money } from "../api.ts";
import { useLive, useResource } from "../live.ts";
import { Badge, Empty, Field, Form, PageHead } from "../components/ui.tsx";
import { navigate } from "../router.tsx";

export function AgentPage({ id }: { id: string }) {
  const agent = useResource<AgentView>(`/agents/${id}`);
  const project = useResource<ProjectView>(agent.data ? `/projects/${agent.data.projectId}` : null);
  const runs = useResource<RunView[]>(`/runs?agentId=${id}`);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  useLive((m) => {
    if (m.kind === "run" && m.run.agentId === id) runs.set((prev) => [m.run, ...(prev ?? []).filter((r) => r.id !== m.run.id)].sort((a, b) => b.createdAt - a.createdAt));
  });
  if (!agent.data) return agent.error ? <p className="error">{agent.error}</p> : null;
  const a = agent.data;
  return (
    <div className="stack">
      <PageHead title={a.name} sub={<>{a.role} on <b>{project.data?.githubRepo ?? "…"}</b> · <span className="mono">{a.modelId}</span></>} />
      <div className="split">
        <section className="stack">
          <h2>Runs</h2>
          {runs.data?.length === 0 && <Empty>No runs yet. Give {a.name} a task.</Empty>}
          {!!runs.data?.length && (
            <table>
              <thead><tr><th>Task</th><th>Status</th><th>Cost</th><th>Started</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} className="link" onClick={() => navigate(`/agents/${id}/runs/${r.id}`)}>
                    <td><b>{r.title}</b><div className="faint mono">{r.branch}</div></td>
                    <td><Badge status={r.status} /></td><td>{money(r.costUsd)}</td><td className="faint">{ago(r.startedAt ?? r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card">
          <h2>New task</h2>
          <Form submit="Start run" onSubmit={async () => {
            const run = await api<RunView>("POST", `/agents/${id}/runs`, { title, brief });
            navigate(`/agents/${id}/runs/${run.id}`);
          }}>
            <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Fix the median helper" /></Field>
            <Field label="Brief" hint="What done looks like. The agent sees only this and the repository."><textarea value={brief} onChange={(e) => setBrief(e.target.value)} required /></Field>
          </Form>
        </section>
      </div>
    </div>
  );
}
