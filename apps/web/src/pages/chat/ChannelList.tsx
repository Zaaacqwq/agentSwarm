import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import type { Agent } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { preview, relativeTime } from "../../lib/format.ts";

export function ChannelList({ activeId }: { activeId: string | undefined }) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data]);

  const rows = (channels.data ?? []).filter((c) => {
    const name = byId.get(c.agentId)?.name ?? "";
    return name.toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <div className="flex h-full flex-col rounded-card border border-line bg-surface/80 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-pill border border-line bg-sunken px-3 text-sm focus-within:border-honey/60">
          <Search size={14} className="text-faint" aria-hidden />
          <input className="w-full bg-transparent placeholder:text-faint focus:outline-none" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search conversations" />
        </label>
        <Button size="sm" variant={picking ? "primary" : "ghost"} icon={<Plus size={14} />} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
          New
        </Button>
      </div>
      {picking ? <AgentPicker agents={agents.data ?? []} onDone={() => setPicking(false)} /> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.map((c) => {
          const agent = byId.get(c.agentId);
          if (!agent) return null;
          const active = c.id === activeId;
          return (
            <li key={c.id}>
              <Link
                to={`/chat/${c.id}`}
                className={`group flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors duration-[var(--duration-fast)] ${active ? "bg-raised shadow-[inset_2px_0_0_var(--color-honey)]" : "hover:bg-raised/60"}`}
              >
                <AgentAvatar seed={agent.avatarSeed} state={c.agentState} label={agent.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold">{agent.name}</span>
                    {c.lastMessage ? <span className="shrink-0 text-[0.7rem] text-faint">{relativeTime(c.lastMessage.createdAt)}</span> : null}
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {c.agentState === "working" ? <em className="text-honey not-italic">working…</em> : c.lastMessage ? preview(c.lastMessage.body, 60) : agent.role || "No messages yet"}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
        {channels.isSuccess && rows.length === 0 ? (
          <li className="px-3 py-8 text-center text-sm text-muted">{query ? "No matches." : "No conversations yet. Press New."}</li>
        ) : null}
      </ul>
    </div>
  );
}

function AgentPicker({ agents, onDone }: { agents: Agent[]; onDone: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const open = useMutation({
    mutationFn: (agentId: string) => api.openDm(agentId),
    onSuccess: (channel) => {
      void client.invalidateQueries({ queryKey: qk.channels });
      onDone();
      void navigate(`/chat/${channel.id}`);
    },
  });
  if (agents.length === 0) {
    return (
      <p className="border-b border-line px-4 py-3 text-sm text-muted">
        No agents yet. <Link to="/agents/new" className="text-honey underline underline-offset-2">Create one</Link>.
      </p>
    );
  }
  return (
    <div className="border-b border-line p-2">
      <p className="px-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-faint">Message an agent</p>
      <ul className="flex flex-wrap gap-1.5 p-1">
        {agents.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => open.mutate(a.id)}
              disabled={open.isPending}
              className="flex items-center gap-2 rounded-pill border border-line bg-sunken py-1 pr-3 pl-1 text-sm transition-colors hover:border-honey/60"
            >
              <AgentAvatar seed={a.avatarSeed} size={24} />
              {a.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
