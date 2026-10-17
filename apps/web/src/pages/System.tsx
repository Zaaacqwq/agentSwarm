import type { CheckItem, RunView } from "@agentswarm/contracts";
import { useResource } from "../live.ts";
import { Badge, PageHead } from "../components/ui.tsx";
import { money } from "../api.ts";

export function SystemPage() {
  const checks = useResource<CheckItem[]>("/system");
  const runs = useResource<RunView[]>("/runs");
  const active = runs.data?.filter((r) => r.status === "running" || r.status === "queued") ?? [];
  const spent = runs.data?.reduce((s, r) => s + r.costUsd, 0) ?? 0;
  const failing = checks.data?.filter((c) => !c.ok) ?? [];
  return (
    <div className="stack">
      <PageHead title="Overview" sub={failing.length ? `${failing.length} check${failing.length > 1 ? "s" : ""} need attention` : "Everything checks out"} action={<button className="btn ghost" onClick={checks.reload}>Re-check</button>} />
      <div className="row" style={{ gap: "var(--space-8)" }}>
        <div className="stat"><b>{active.length}</b><span>Active runs</span></div>
        <div className="stat"><b>{runs.data?.length ?? 0}</b><span>Recent runs</span></div>
        <div className="stat"><b>{money(spent)}</b><span>Spent (recent)</span></div>
      </div>
      <section className="card" aria-labelledby="checks">
        <h2 id="checks">System checks</h2>
        <table>
          <tbody>
            {checks.data?.map((c) => (
              <tr key={c.name}><td style={{ width: 120 }}><Badge status={c.ok ? "ok" : "bad"}>{c.ok ? "ok" : "check"}</Badge></td><td>{c.name}<div className="faint">{c.detail}</div></td></tr>
            ))}
          </tbody>
        </table>
        {checks.error && <p className="error">{checks.error}</p>}
      </section>
    </div>
  );
}
