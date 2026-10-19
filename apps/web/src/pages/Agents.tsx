import { useEffect, useState } from "react";
import type { AgentView, EndpointView, ModelView, ProjectView } from "@agentswarm/contracts";
import { api } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, Field, Form, PageHead } from "../components/ui.tsx";
import { navigate } from "../router.tsx";

export function AgentsPage() {
  const agents = useResource<AgentView[]>("/agents");
  const projects = useResource<ProjectView[]>("/projects");
  const [creating, setCreating] = useState(false);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "—";
  return (
    <div className="stack">
      <PageHead title="Agents" sub="Each agent works on one project, in its own workstation per run." action={<button className="btn signal" onClick={() => setCreating((c) => !c)}>{creating ? "Close" : "New agent"}</button>} />
      {creating && <NewAgent projects={projects.data ?? []} onCreated={(a) => navigate(`/agents/${a.id}`)} />}
      {agents.data?.length === 0 && !creating && <Empty>No agents yet. Add an endpoint and a project in Settings and Projects, then create one.</Empty>}
      {!!agents.data?.length && (
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Project</th><th>Model</th></tr></thead>
          <tbody>
            {agents.data.map((a) => (
              <tr key={a.id} className="link" onClick={() => navigate(`/agents/${a.id}`)}>
                <td><b>{a.name}</b></td><td>{a.role}</td><td>{projectName(a.projectId)}</td><td className="mono">{a.modelId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewAgent({ projects, onCreated }: { projects: ProjectView[]; onCreated: (a: AgentView) => void }) {
  const endpoints = useResource<EndpointView[]>("/endpoints");
  const [name, setName] = useState("");
  const [role, setRole] = useState("developer");
  const [projectId, setProjectId] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [modelId, setModelId] = useState("qwen/qwen3.8-omni-flash");
  const [instructions, setInstructions] = useState("");
  const [models, setModels] = useState<ModelView[]>([]);
  useEffect(() => void (projects[0] && !projectId && setProjectId(projects[0].id)), [projects, projectId]);
  useEffect(() => void (endpoints.data?.[0] && !endpointId && setEndpointId(endpoints.data[0].id)), [endpoints.data, endpointId]);
  useEffect(() => {
    if (endpointId) api<ModelView[]>("GET", `/endpoints/${endpointId}/models`).then(setModels).catch(() => setModels([]));
  }, [endpointId]);
  return (
    <section className="card">
      <Form submit="Create agent" onSubmit={async () => onCreated(await api<AgentView>("POST", "/agents", { name, role, projectId, endpointId, modelId, instructions }))}>
        <div className="grid">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} /></Field>
          <Field label="Role"><input value={role} onChange={(e) => setRole(e.target.value)} required maxLength={40} /></Field>
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Endpoint">
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} required>
              {endpoints.data?.map((ep) => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Model" hint={models.length ? `${models.length} models on this endpoint` : undefined}>
          <input list="models" value={modelId} onChange={(e) => setModelId(e.target.value)} required />
          <datalist id="models">{models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.vision ? " · vision" : ""}</option>)}</datalist>
        </Field>
        <Field label="Instructions" hint="Optional: how this agent should work."><textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field>
      </Form>
    </section>
  );
}
