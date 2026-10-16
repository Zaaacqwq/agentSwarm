import type { WorkstationView } from "@hive/contracts";
import { api, ago } from "../api.ts";
import { useLive, useResource } from "../live.ts";
import { Badge, Empty, PageHead } from "../components/ui.tsx";

export function WorkstationsPage() {
  const ws = useResource<WorkstationView[]>("/workstations");
  useLive((m) => {
    if (m.kind === "workstation") ws.set((prev) => prev?.map((w) => (w.id === m.workstation.id ? m.workstation : w)) ?? prev);
  });
  return (
    <div className="stack">
      <PageHead title="Workstations" sub="Separate macOS users; each run holds one while it works." action={<button className="btn ghost" onClick={() => api<WorkstationView[]>("POST", "/workstations/check", {}).then((d) => ws.set(() => d))}>Check all</button>} />
      {ws.data?.length === 0 && <Empty>No workstation users found. Run <code>sudo zsh scripts/setup.sh</code>.</Empty>}
      <div className="grid">
        {ws.data?.map((w) => (
          <div key={w.id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}><h2 className="mono">{w.id}</h2><Badge status={w.status} /></div>
            <p className="faint">{w.runId ? <>Running <span className="mono">{w.runId.slice(0, 12)}…</span></> : "Idle"} · checked {ago(w.lastCheckAt)}</p>
            {w.lastError && <p className="error">{w.lastError}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
