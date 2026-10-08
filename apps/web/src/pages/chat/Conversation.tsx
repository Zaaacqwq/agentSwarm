import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import type { Agent, Message, MessagePage } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { clockTime } from "../../lib/format.ts";
import { Composer } from "./Composer.tsx";

const GROUP_GAP_MS = 5 * 60 * 1000;

export function Conversation({ channelId }: { channelId: string }) {
  const client = useQueryClient();
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels });
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const page = useQuery({ queryKey: qk.messages(channelId), queryFn: () => api.messages(channelId) });
  const channel = channels.data?.find((c) => c.id === channelId);
  const agent = agents.data?.find((a) => a.id === channel?.agentId);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messages = page.data?.messages ?? [];
  const groups = useMemo(() => groupMessages(messages), [messages]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, channel?.agentState]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => (stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await api.messages(channelId, oldest.id);
      client.setQueryData<MessagePage>(qk.messages(channelId), (cur) =>
        cur ? { messages: [...older.messages, ...cur.messages], hasMore: older.hasMore } : cur,
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (channels.isSuccess && !channel) {
    return <p className="p-6 text-muted">This conversation no longer exists.</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface/80 backdrop-blur">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/chat" className="rounded-full p-1 text-muted hover:text-ink md:hidden" aria-label="Back to conversations">
          <ArrowLeft size={18} />
        </Link>
        {agent ? <AgentAvatar seed={agent.avatarSeed} state={channel?.agentState} size={36} label={agent.name} /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-bold leading-tight">{agent?.name ?? "…"}</h2>
          <p className="truncate text-xs text-muted">{agent ? `${agent.role || "agent"} · ${agent.modelId}` : ""}</p>
        </div>
        {agent ? (
          <Link to={`/agents/${agent.id}`} className="rounded-pill p-2 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label="Agent settings">
            <SlidersHorizontal size={16} />
          </Link>
        ) : null}
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {page.data?.hasMore ? (
          <div className="mb-4 flex justify-center">
            <Button size="sm" variant="quiet" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </Button>
          </div>
        ) : null}
        {page.isSuccess && messages.length === 0 && agent ? <Intro agent={agent} /> : null}
        <ol className="space-y-5" aria-label="Messages">
          {groups.map((g) => (
            <MessageGroup key={g[0]!.id} messages={g} agent={agent} />
          ))}
        </ol>
        {channel?.agentState === "working" || channel?.agentState === "queued" ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <Dots />
            {agent?.name ?? "Agent"} is {channel.agentState === "working" ? "working" : "queued"}…
          </p>
        ) : null}
      </div>

      <Composer channelId={channelId} agent={agent} working={channel?.agentState === "working"} onSent={() => (stickToBottom.current = true)} />
    </div>
  );
}

function MessageGroup({ messages, agent }: { messages: Message[]; agent: Agent | undefined }) {
  const first = messages[0]!;
  if (first.authorKind === "system") {
    return (
      <li className="flex justify-center">
        <div className="max-w-[85%] space-y-1 rounded-2xl border border-warn/25 bg-warn/5 px-3.5 py-2 text-center text-sm text-warn">
          {messages.map((m) => <p key={m.id}>{m.body}</p>)}
        </div>
      </li>
    );
  }
  const mine = first.authorKind === "user";
  return (
    <li className={`flex gap-3 ${mine ? "flex-row-reverse" : ""}`}>
      {!mine && agent ? <AgentAvatar seed={agent.avatarSeed} size={32} label={agent.name} /> : null}
      <div className={`flex max-w-[min(42rem,85%)] flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
        <span className="px-1 text-[0.7rem] font-semibold text-faint">
          {mine ? "You" : agent?.name ?? "Agent"} · {clockTime(first.createdAt)}
        </span>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-[1.1rem] px-3.5 py-2.5 ${mine ? "rounded-tr-md bg-honey/90 text-honey-ink" : "rounded-tl-md border border-line bg-raised"}`}
          >
            {mine ? <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{m.body}</p> : <Markdown text={m.body} />}
          </div>
        ))}
      </div>
    </li>
  );
}

function Intro({ agent }: { agent: Agent }) {
  return (
    <div className="mx-auto mb-6 max-w-md space-y-3 rounded-card border border-dashed border-line px-6 py-8 text-center">
      <AgentAvatar seed={agent.avatarSeed} size={56} label={agent.name} />
      <p className="text-lg font-bold">Say hello to {agent.name}</p>
      <p className="text-sm text-muted">Messages wake the agent. It replies through its send_message tool; its private reasoning stays in the activity inspector.</p>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-bounce rounded-full bg-honey" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </span>
  );
}

function groupMessages(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const m of messages) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_GAP_MS) {
      groups[groups.length - 1] = [...last, m];
    } else {
      groups.push([m]);
    }
  }
  return groups;
}
