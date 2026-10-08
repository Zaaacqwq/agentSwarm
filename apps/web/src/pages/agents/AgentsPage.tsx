import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { AgentEditor } from "./AgentEditor.tsx";
import { ActivityInspector } from "./ActivityInspector.tsx";

export function AgentsPage() {
  const { agentId } = useParams();
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const selected = agentId && agentId !== "new" ? agents.data?.find((a) => a.id === agentId) : undefined;
  const editing = agentId === "new" || selected;

  return (
    <div className="mx-auto flex h-full max-w-7xl gap-3">
      <aside className={`${editing ? "hidden lg:flex" : "flex"} w-full flex-col rounded-card border border-line bg-surface/80 backdrop-blur lg:w-72 lg:shrink-0`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h1 className="font-bold">Agents</h1>
          <Link to="/agents/new" className="flex items-center gap-1 rounded-pill bg-honey px-3 py-1.5 text-xs font-bold text-honey-ink shadow-glow transition-transform active:translate-y-px">
            <Plus size={13} strokeWidth={3} /> New agent
          </Link>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
          {(agents.data ?? []).map((a) => (
            <li key={a.id}>
              <Link
                to={`/agents/${a.id}`}
                className={`flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors ${a.id === agentId ? "bg-raised shadow-[inset_2px_0_0_var(--color-honey)]" : "hover:bg-raised/60"}`}
              >
                <AgentAvatar seed={a.avatarSeed} state={a.state} label={a.name} />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{a.name}</span>
                  <span className="block truncate text-xs text-muted">{a.role || a.modelId}</span>
                </span>
              </Link>
            </li>
          ))}
          {agents.isSuccess && agents.data.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted">No agents yet. Create your first one.</li>
          ) : null}
        </ul>
      </aside>

      {editing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto xl:flex-row xl:overflow-hidden">
          <AgentEditor key={agentId} agent={selected} />
          {selected ? <ActivityInspector agent={selected} /> : null}
        </div>
      ) : (
        <div className="hidden flex-1 place-items-center rounded-card border border-dashed border-line text-sm text-muted lg:grid">
          Select an agent to edit its settings and inspect its runs.
        </div>
      )}
    </div>
  );
}
