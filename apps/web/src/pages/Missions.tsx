import { useEffect, useState } from "react";
import type { MissionView, ProjectView } from "@agentswarm/contracts";
import { ago, api, money } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Empty, Field, Form, PageHead } from "../components/ui.tsx";
import { STAGE_LABEL, StageRail } from "../components/StageRail.tsx";
import { navigate } from "../router.tsx";

export function MissionsPage() {
  const missions = useResource<MissionView[]>("/missions");
  const [creating, setCreating] = useState(false);
  useReconnect(missions.reload);
  useLive((m) => {
    if (m.kind !== "mission") return;
    missions.set((prev) => (prev?.some((x) => x.id === m.mission.id) ? prev.map((x) => (x.id === m.mission.id ? m.mission : x)) : [m.mission, ...(prev ?? [])]));
  });
  const list = missions.data ?? [];
  const needYou = list.filter((m) => m.waitingForYou).length;
  return (
    <div className="stack">
      <PageHead title="Missions" sub={needYou ? <><b className="needs-you">{needYou} waiting for you</b> · one idea each, from your words to a pull request</> : "One idea each, from your words to a pull request."}
        action={<button className="btn signal" onClick={() => setCreating((c) => !c)}>{creating ? "Close" : "New mission"}</button>} />
      {creating && <NewMission onCreated={(m) => navigate(`/missions/${m.id}`)} />}
      {missions.data && list.length === 0 && !creating && <Empty>No missions yet. Start one here, or with /idea in Discord.</Empty>}
      {list.length > 0 && (
        <ul className="missions">
          {list.map((m) => (
            <li key={m.id}>
              <a href={`/missions/${m.id}`} className={`mission-row${m.waitingForYou ? " attention" : ""}`} onClick={(e) => {
                if (e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                navigate(`/missions/${m.id}`);
              }}>
                <div className="mission-title">
                  <b>{m.title}</b>
                  <span className="faint">{m.githubRepo} · {ago(m.updatedAt)}</span>
                </div>
                <StageRail stage={m.stage} fast={m.fast} compact />
                <div className="mission-meta">
                  <span className={m.waitingForYou ? "needs-you" : "muted"}>{m.waitingForYou ? "Needs you · " : ""}{STAGE_LABEL[m.stage]}</span>
                  <span className="faint">{money(m.costUsd)} of {money(m.budgetUsd)}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewMission({ onCreated }: { onCreated: (m: MissionView) => void }) {
  const projects = useResource<ProjectView[]>("/projects");
  const [idea, setIdea] = useState("");
  const [projectId, setProjectId] = useState("");
  const [fast, setFast] = useState(false);
  const [budget, setBudget] = useState("3");
  useEffect(() => void (projects.data?.[0] && !projectId && setProjectId(projects.data[0].id)), [projects.data, projectId]);
  return (
    <section className="card">
      <Form submit="Start the mission" onSubmit={async () => onCreated(await api<MissionView>("POST", "/missions", { projectId, idea, fast, budgetUsd: Number(budget) }))}>
        <Field label="Your idea" hint="Say it as you would to a colleague. The lead asks if something is unclear.">
          <textarea className="idea" value={idea} onChange={(e) => setIdea(e.target.value)} required minLength={3} maxLength={4000} placeholder="A page where I paste CSV and get a Markdown table" />
        </Field>
        <div className="grid">
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.githubRepo}</option>)}
            </select>
          </Field>
          <Field label="Budget (USD)" hint="For the whole mission, every agent included.">
            <input type="number" min={0.1} max={50} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} required />
          </Field>
          <Field label="Fast track" hint="Small change: skip research and discussion.">
            <span className="row"><input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /> Skip to planning</span>
          </Field>
        </div>
      </Form>
    </section>
  );
}
