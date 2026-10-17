import { useEffect, useState } from "react";
import type { Me } from "@agentswarm/contracts";
import { api, ApiError } from "./api.ts";
import { Link, usePath } from "./router.tsx";
import { Login } from "./pages/Login.tsx";
import { SystemPage } from "./pages/System.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { AgentPage } from "./pages/Agent.tsx";
import { RunPage } from "./pages/Run.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { WorkstationsPage } from "./pages/Workstations.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { MissionsPage } from "./pages/Missions.tsx";
import { MissionPage } from "./pages/Mission.tsx";

const Mark = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2l12 7v14l-12 7-12-7V9z" fill="var(--signal)" /><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="var(--paper)" /></svg>
);

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  useEffect(() => {
    api<Me>("GET", "/me").then(setMe).catch((e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setMe(null)));
  }, []);
  if (me === undefined) return null;
  if (me === null) return <Login onDone={setMe} />;

  const logout = async () => {
    await api("POST", "/auth/logout", {});
    setMe(null);
  };
  const [, section, id, sub, subId] = path.split("/");
  let page;
  if (section === "agents" && id && sub === "runs" && subId) page = <RunPage id={subId} />;
  else if (section === "agents" && id) page = <AgentPage id={id} />;
  else if (section === "missions" && id) page = <MissionPage id={id} />;
  else if (section === "missions") page = <MissionsPage />;
  else if (section === "agents") page = <AgentsPage />;
  else if (section === "projects") page = <ProjectsPage />;
  else if (section === "workstations") page = <WorkstationsPage />;
  else if (section === "settings") page = <SettingsPage />;
  else page = <SystemPage />;

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand"><Mark /> agentSwarm</div>
        <Link to="/">Overview</Link>
        <Link to="/missions">Missions</Link>
        <Link to="/agents">Agents</Link>
        <Link to="/projects">Projects</Link>
        <Link to="/workstations">Workstations</Link>
        <Link to="/settings">Settings</Link>
        <div className="spacer" />
        <button className="btn ghost" onClick={logout}>Sign out {me.username}</button>
      </nav>
      <main className="main">{page}</main>
    </div>
  );
}
