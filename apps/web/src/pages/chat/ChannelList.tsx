import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Plus, Search, Users } from "lucide-react";
import type { Agent, Channel } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { preview, relativeTime } from "../../lib/format.ts";
import { GroupDialog } from "./GroupDialog.tsx";

const SECTIONS: { kind: Channel["kind"]; label: string }[] = [
  { kind: "group", label: "Groups" },
  { kind: "dm", label: "Direct" },
  { kind: "agent_dm", label: "Between agents" },
];

export function ChannelList({ activeId }: { activeId: string | undefined }) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<"closed" | "dm" | "group">("closed");
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data]);
  const needle = query.trim().toLowerCase();
  const rows = (channels.data ?? []).filter((c) => (c.title ?? "").toLowerCase().includes(needle));

  return (
    <div className="flex h-full flex-col rounded-card border border-line bg-surface/80 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-pill border border-line bg-sunken px-3 text-sm focus-within:border-honey/60">
          <Search size={14} className="text-faint" aria-hidden />
          <input className="w-full bg-transparent placeholder:text-faint focus:outline-none" placeholder="Filter chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter conversations" />
        </label>
        <Button size="sm" variant={menu === "dm" ? "primary" : "ghost"} icon={<Plus size={14} />} onClick={() => setMenu((m) => (m === "dm" ? "closed" : "dm"))} aria-expanded={menu === "dm"}>DM</Button>
        <Button size="sm" variant={menu === "group" ? "primary" : "ghost"} icon={<Users size={14} />} onClick={() => setMenu("group")} aria-label="New group" />
      </div>
      {menu === "dm" ? <AgentPicker agents={agents.data ?? []} onDone={() => setMenu("closed")} /> : null}
      {menu === "group" ? <GroupDialog onClose={() => setMenu("closed")} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {SECTIONS.map(({ kind, label }) => {
          const list = rows.filter((c) => c.kind === kind);
          if (list.length === 0) return null;
          return (
            <section key={kind} aria-label={label} className="mb-2">
              <h2 className="px-3 pt-2 pb-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-faint">{label}</h2>
              <ul>{list.map((c) => <ChannelRow key={c.id} channel={c} active={c.id === activeId} agents={byId} />)}</ul>
            </section>
          );
        })}
        {channels.isSuccess && rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted">{query ? "No matches." : "No conversations yet. Start a DM or a group."}</p>
        ) : null}
      </div>
    </div>
  );
}

function ChannelRow({ channel: c, active, agents }: { channel: Channel; active: boolean; agents: Map<string, Agent> }) {
  const agentMembers = c.members.filter((m) => m.kind === "agent").map((m) => agents.get(m.id)).filter((a): a is Agent => !!a);
  const working = agentMembers.filter((a) => a.state === "working");
  return (
    <li>
      <Link
        to={`/chat/${c.id}`}
        className={`group flex items-center gap-3 rounded-2xl px-2.5 py-2.5 transition-colors duration-[var(--duration-fast)] ${active ? "bg-raised shadow-[inset_2px_0_0_var(--color-honey)]" : "hover:bg-raised/60"}`}
      >
        <ChannelGlyph channel={c} agents={agentMembers} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-semibold">{c.title}</span>
            {c.lastMessage ? <span className="shrink-0 text-[0.7rem] text-faint">{relativeTime(c.lastMessage.createdAt)}</span> : null}
          </span>
          <span className="block truncate text-sm text-muted">
            {working.length ? (
              <em className="text-honey not-italic">{working.map((a) => a.name).join(", ")} working…</em>
            ) : c.lastMessage ? (
              `${c.kind === "dm" ? "" : `${c.lastMessage.authorName}: `}${preview(c.lastMessage.body, 60)}`
            ) : (
              "No messages yet"
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ChannelGlyph({ channel, agents }: { channel: Channel; agents: Agent[] }) {
  if (channel.kind === "dm" && agents[0]) return <AgentAvatar seed={agents[0].avatarSeed} state={channel.agentState} label={agents[0].name} />;
  if (channel.kind === "agent_dm") {
    return (
      <span className="relative block size-10 shrink-0">
        {agents[0] ? <span className="absolute top-0 left-0"><AgentAvatar seed={agents[0].avatarSeed} size={26} /></span> : null}
        {agents[1] ? <span className="absolute right-0 bottom-0"><AgentAvatar seed={agents[1].avatarSeed} size={26} /></span> : null}
      </span>
    );
  }
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[0.9rem] border border-honey/30 bg-honey/10 text-honey">
      <Hash size={18} strokeWidth={2.4} aria-hidden />
    </span>
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
    return <p className="border-b border-line px-4 py-3 text-sm text-muted">No agents yet. <Link to="/agents/new" className="text-honey underline underline-offset-2">Create one</Link>.</p>;
  }
  return (
    <div className="border-b border-line p-2">
      <p className="px-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-faint">Message an agent</p>
      <ul className="flex flex-wrap gap-1.5 p-1">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => open.mutate(a.id)} disabled={open.isPending} className="flex items-center gap-2 rounded-pill border border-line bg-sunken py-1 pr-3 pl-1 text-sm transition-colors hover:border-honey/60">
              <AgentAvatar seed={a.avatarSeed} size={24} />
              {a.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
