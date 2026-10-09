import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, FileText, Hash, Paperclip, Pencil, SlidersHorizontal } from "lucide-react";
import type { Agent, Channel, Message, MessagePage } from "@hive/core";
import { api, qk, type QueueMap } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { GroupDialog } from "./GroupDialog.tsx";

export function Conversation({ channelId }: { channelId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focusId = Number(params.get("m")) || undefined;
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const queue = useQuery<QueueMap>({ queryKey: qk.queue, queryFn: () => ({}), staleTime: Infinity });
  // A search jump loads a window around one message; keep it apart from the live latest page.
  const pageKey = focusId ? [...qk.messages(channelId), "around", focusId] : qk.messages(channelId);
  const page = useQuery({
    queryKey: pageKey,
    queryFn: () => api.messages(channelId, focusId ? { around: focusId } : {}),
  });
  const channel = channels.data?.find((c) => c.id === channelId);
  const byId = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data]);
  const members = (channel?.members ?? []).filter((m) => m.kind === "agent").map((m) => byId.get(m.id)).filter((a): a is Agent => !!a);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(!focusId);
  const messages = page.data?.messages ?? [];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, members.map((m) => m.state).join()]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await api.messages(channelId, { before: oldest.id });
      client.setQueryData<MessagePage>(pageKey, (cur) => (cur ? { messages: [...older.messages, ...cur.messages], hasMore: older.hasMore } : cur));
    } finally {
      setLoadingOlder(false);
    }
  };

  if (channels.isSuccess && !channel) return <p className="p-6 text-muted">This conversation no longer exists.</p>;
  const readOnly = channel?.kind === "agent_dm";
  const busy = members.filter((a) => a.state !== "idle");

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface/80 backdrop-blur">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/chat" className="rounded-full p-1 text-muted hover:text-ink md:hidden" aria-label="Back to conversations"><ArrowLeft size={18} /></Link>
        {channel ? <HeaderIdentity channel={channel} members={members} /> : null}
        <div className="relative ml-auto flex items-center gap-1">
          <Button size="sm" variant="quiet" icon={<Paperclip size={14} />} onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles}>Files</Button>
          {showFiles ? <FilesPanel channelId={channelId} /> : null}
          {channel?.kind === "group" ? <Button size="sm" variant="quiet" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button> : null}
          {channel?.kind === "dm" && members[0] ? (
            <Link to={`/agents/${members[0].id}`} className="rounded-pill p-2 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label="Agent settings"><SlidersHorizontal size={16} /></Link>
          ) : null}
        </div>
      </header>
      {editing && channel ? <GroupDialog group={channel} onClose={() => setEditing(false)} /> : null}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
        {page.data?.hasMore ? (
          <div className="mb-4 flex justify-center">
            <Button size="sm" variant="quiet" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load earlier messages"}</Button>
          </div>
        ) : null}
        {page.isSuccess && messages.length === 0 && channel ? <Intro channel={channel} members={members} /> : null}
        {channel ? (
          <MessageList
            channel={channel}
            messages={messages}
            agents={byId}
            focusId={focusId}
            canAct={!readOnly}
            onReply={readOnly ? undefined : (m) => setReplyTo(m)}
          />
        ) : null}
        {busy.length ? (
          <ul className="mt-4 space-y-1 text-sm text-muted" aria-live="polite">
            {busy.map((a) => <li key={a.id} className="flex items-center gap-2"><Dots />{statusLine(a, queue.data?.[a.id])}</li>)}
          </ul>
        ) : null}
      </div>

      {readOnly ? (
        <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-sm text-muted"><Eye size={14} aria-hidden /> Agents talk here on their own. You can read along but not post.</p>
      ) : channel ? (
        <Composer channel={channel} members={members} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSent={() => {
          stick.current = true;
          setReplyTo(null);
          // Leave a search-jump window so the new message shows on the live page.
          if (focusId) void navigate(`/chat/${channelId}`, { replace: true });
        }} />
      ) : null}
    </div>
  );
}

function statusLine(agent: Agent, queue: QueueMap[string]): string {
  if (agent.state === "queued") {
    const pos = queue?.position ? ` (#${queue.position} in line${queue.waitingFor ? `, waiting for ${queue.waitingFor}` : ""})` : "";
    return `${agent.name} is queued${pos}`;
  }
  if (queue?.waitingFor) return `${agent.name} is waiting for ${queue.waitingFor}`;
  return `${agent.name} is working…`;
}

function HeaderIdentity({ channel, members }: { channel: Channel; members: Agent[] }) {
  if (channel.kind === "dm" && members[0]) {
    return (
      <>
        <AgentAvatar seed={members[0].avatarSeed} state={members[0].state} size={36} label={members[0].name} />
        <div className="min-w-0">
          <h2 className="truncate font-bold leading-tight">{members[0].name}</h2>
          <p className="truncate text-xs text-muted">{members[0].role || "agent"} · {members[0].modelId}</p>
        </div>
      </>
    );
  }
  return (
    <>
      {channel.kind === "group" ? (
        <span className="grid size-9 place-items-center rounded-[0.8rem] border border-honey/30 bg-honey/10 text-honey"><Hash size={17} strokeWidth={2.4} aria-hidden /></span>
      ) : null}
      <div className="min-w-0">
        <h2 className="truncate font-bold leading-tight">{channel.title}</h2>
        <div className="mt-0.5 flex -space-x-1.5">
          {members.map((a) => <AgentAvatar key={a.id} seed={a.avatarSeed} state={a.state} size={20} label={a.name} />)}
        </div>
      </div>
    </>
  );
}

function Intro({ channel, members }: { channel: Channel; members: Agent[] }) {
  const text = channel.kind === "group"
    ? `Agents here wake only when @mentioned. Try "@${members[0]?.name ?? "Agent"} …" or "@all".`
    : channel.kind === "agent_dm"
      ? "No messages between these agents yet."
      : "Messages wake the agent. It replies through send_message; its private reasoning stays in the activity inspector.";
  return (
    <div className="mx-auto mb-6 max-w-md space-y-2 rounded-card border border-dashed border-line px-6 py-8 text-center">
      <p className="text-lg font-bold">{channel.title}</p>
      <p className="text-sm text-muted">{text}</p>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-bounce rounded-full bg-honey" style={{ animationDelay: `${i * 120}ms` }} />)}
    </span>
  );
}

function FilesPanel({ channelId }: { channelId: string }) {
  const files = useQuery({ queryKey: qk.channelFiles(channelId), queryFn: () => api.channelFiles(channelId) });
  return (
    <div className="absolute top-10 right-0 z-20 w-72 rounded-2xl border border-line bg-surface p-2 shadow-lift">
      <p className="px-2 pb-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-faint">Files in this chat</p>
      <ul className="max-h-72 overflow-y-auto">
        {(files.data ?? []).map((f) => (
          <li key={f.id}>
            <a href={api.fileUrl(f.id)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-raised">
              <FileText size={13} className="shrink-0 text-honey" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-faint">{Math.max(1, Math.round(f.size / 1024))} KB</span>
            </a>
          </li>
        ))}
        {files.isSuccess && files.data.length === 0 ? <li className="px-2 py-3 text-sm text-muted">No files yet.</li> : null}
      </ul>
    </div>
  );
}
