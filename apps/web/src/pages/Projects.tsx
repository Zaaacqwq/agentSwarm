import { useState } from "react";
import type { GitHubStatus, ProjectView, PushView } from "@agentswarm/contracts";
import { api, ago } from "../api.ts";
import { useResource } from "../live.ts";
import { Badge, Empty, Field, Form, PageHead } from "../components/ui.tsx";

export function ProjectsPage() {
  const projects = useResource<ProjectView[]>("/projects");
  const github = useResource<GitHubStatus>("/github");
  const [repo, setRepo] = useState("");
  return (
    <div className="stack">
      <PageHead title="Projects" sub="A project is a GitHub repository. agentSwarm mirrors it and protects its default branch." />
      {github.data && !github.data.configured && <div className="card">Add a GitHub token in Settings first.</div>}
      <section className="card">
        <Form submit="Add project" onSubmit={async () => {
          await api("POST", "/projects", { githubRepo: repo.trim() });
          setRepo("");
          projects.reload();
        }}>
          <Field label="GitHub repository" hint="owner/name, readable with agentSwarm's token"><input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Zaaacqwq/agentswarm-playground" required /></Field>
        </Form>
      </section>
      {projects.data?.length === 0 && <Empty>No projects yet.</Empty>}
      {projects.data?.map((p) => <Project key={p.id} p={p} onChange={projects.reload} />)}
    </div>
  );
}

function Project({ p, onChange }: { p: ProjectView; onChange: () => void }) {
  const pushes = useResource<PushView[]>(`/projects/${p.id}/pushes`);
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>{p.name}</h2>
          <div className="faint"><span className="mono">{p.githubRepo}</span> · default <span className="mono">{p.defaultBranch}</span> · fetched {ago(p.lastFetchedAt)}</div>
        </div>
        <div className="row">
          <Badge status={p.protectedAt ? "ok" : "bad"}>{p.protectedAt ? `${p.defaultBranch} protected` : `${p.defaultBranch} not protected`}</Badge>
          {!p.protectedAt && <button className="btn" onClick={() => api("POST", `/projects/${p.id}/protect`, {}).then(onChange).catch((e: Error) => alert(e.message))}>Protect</button>}
          <button className="btn ghost" onClick={() => api("POST", `/projects/${p.id}/refresh`, {}).then(onChange).catch((e: Error) => alert(e.message))}>Fetch</button>
        </div>
      </div>
      {!!pushes.data?.length && (
        <table>
          <thead><tr><th>Pushed branch</th><th>Result</th><th>When</th></tr></thead>
          <tbody>{pushes.data.slice(0, 10).map((x) => (
            <tr key={x.id}><td className="mono">{x.branch}</td><td><Badge status={x.status} />{x.reason && <div className="faint">{x.reason}</div>}</td><td className="faint">{ago(x.createdAt)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
