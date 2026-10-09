import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CornerUpLeft, FileText, SmilePlus } from "lucide-react";
import type { Agent, Channel, Message, MessagePage } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { avatarTraits } from "../../lib/avatar.ts";
import { clockTime, preview } from "../../lib/format.ts";

const GROUP_GAP_MS = 5 * 60 * 1000;
export const QUICK_REACTIONS = ["👍", "🎉", "👀", "✅", "❤️", "😂"] as const;

interface Props {
  channel: Channel;
  messages: Message[];
  agents: Map<string, Agent>;
  focusId: number | undefined;
  canAct: boolean;
  onReply: ((m: Message) => void) | undefined;
}

export function MessageList({ channel, messages, agents, focusId, canAct, onReply }: Props) {
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  useEffect(() => {
    if (focusId) document.getElementById(`msg-${focusId}`)?.scrollIntoView({ block: "center" });
  }, [focusId, messages.length > 0]);
  // In an agent DM, the first agent member sits left; everyone else's bubbles go right.
  const leftAgent = channel.kind === "agent_dm" ? channel.members.find((m) => m.kind === "agent")?.id : undefined;

  return (
    <ol className="space-y-5" aria-label="Messages">
      {groups.map((g) => (
        <Group key={g[0]!.id} messages={g} agents={agents} byId={byId} focusId={focusId} canAct={canAct} onReply={onReply}
          rightSide={g[0]!.authorKind === "user" || (leftAgent !== undefined && g[0]!.authorId !== leftAgent)} />
      ))}
    </ol>
  );
}

function Group({ messages, agents, byId, focusId, canAct, onReply, rightSide }: {
  messages: Message[]; agents: Map<string, Agent>; byId: Map<number, Message>; focusId: number | undefined;
  canAct: boolean; onReply: Props["onReply"]; rightSide: boolean;
}) {
  const first = messages[0]!;
  if (first.authorKind === "system") {
    return (
      <li className="flex justify-center">
        <div className="max-w-[85%] space-y-1 rounded-2xl border border-warn/25 bg-warn/5 px-3.5 py-2 text-center text-sm text-warn">
          {messages.map((m) => <p key={m.id} id={`msg-${m.id}`}>{m.body}</p>)}
        </div>
      </li>
    );
  }
  const agent = first.authorKind === "agent" ? agents.get(first.authorId) : undefined;
  const mine = first.authorKind === "user";
  const tint = agent ? `oklch(72% 0.13 ${avatarTraits(agent.avatarSeed).hue} / 0.12)` : undefined;
  return (
    <li className={`flex gap-3 ${rightSide ? "flex-row-reverse" : ""}`}>
      {!mine ? (agent ? <AgentAvatar seed={agent.avatarSeed} size={32} label={agent.name} /> : <span className="size-8 shrink-0 rounded-xl bg-raised" aria-hidden />) : null}
      <div className={`flex max-w-[min(42rem,85%)] min-w-0 flex-col gap-1 ${rightSide ? "items-end" : "items-start"}`}>
        <span className="px-1 text-[0.7rem] font-semibold text-faint">{mine ? "You" : first.authorName} · {clockTime(first.createdAt)}</span>
        {messages.map((m) => (
          <Bubble key={m.id} message={m} mine={mine} tint={tint} replied={m.replyToId ? byId.get(m.replyToId) : undefined} agents={agents}
            focused={m.id === focusId} canAct={canAct} onReply={onReply} />
        ))}
      </div>
    </li>
  );
}

function Bubble({ message: m, mine, tint, replied, agents, focused, canAct, onReply }: {
  message: Message; mine: boolean; tint: string | undefined; replied: Message | undefined; agents: Map<string, Agent>;
  focused: boolean; canAct: boolean; onReply: Props["onReply"];
}) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const react = useMutation({
    mutationFn: ({ emoji, add }: { emoji: string; add: boolean }) => api.react(m.id, emoji, add),
    onSuccess: (updated) => client.setQueryData<MessagePage>(qk.messages(m.channelId), (p) => (p ? { ...p, messages: p.messages.map((x) => (x.id === updated.id ? updated : x)) } : p)),
  });
  const mineReacted = (emoji: string) => m.reactions.some((r) => r.emoji === emoji && r.actors.some((a) => a.kind === "user"));

  return (
    <div id={`msg-${m.id}`} className={`group/msg relative flex max-w-full flex-col ${mine ? "items-end" : "items-start"}`} tabIndex={-1}>
      {m.replyToId ? (
        <a href={`#msg-${m.replyToId}`} className="mb-0.5 flex max-w-full items-center gap-1 truncate px-2 text-xs text-faint hover:text-muted">
          <CornerUpLeft size={11} aria-hidden /> {replied ? `${replied.authorName}: ${preview(replied.body, 60)}` : `message #${m.replyToId}`}
        </a>
      ) : null}
      <div
        className={`max-w-full rounded-[1.1rem] px-3.5 py-2.5 transition-shadow ${focused ? "ring-2 ring-honey/70" : ""} ${mine ? "rounded-tr-md bg-honey/90 text-honey-ink" : "rounded-tl-md border border-line"}`}
        style={mine ? undefined : { background: tint ?? "var(--color-raised)" }}
      >
        {mine ? <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{highlightMentions(m.body, agents)}</p> : <Markdown text={m.body} />}
      </div>
      {m.attachments.length ? <Attachments message={m} /> : null}
      {m.reactions.length ? (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="Reactions">
          {m.reactions.map((r) => {
            const active = mineReacted(r.emoji);
            return (
              <li key={r.emoji}>
                <button type="button" disabled={!canAct || react.isPending} onClick={() => react.mutate({ emoji: r.emoji, add: !active })}
                  title={r.actors.map((a) => (a.kind === "user" ? "You" : agents.get(a.id)?.name ?? "agent")).join(", ")}
                  className={`rounded-pill border px-2 py-0.5 text-xs transition-colors ${active ? "border-honey/60 bg-honey/15" : "border-line bg-sunken hover:border-line-strong"}`}>
                  {r.emoji} <span className="text-muted">{r.actors.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canAct ? (
        <div className={`absolute -top-3 ${mine ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1"} flex gap-0.5 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 max-sm:hidden`}>
          {onReply ? <IconButton label="Reply" onClick={() => onReply(m)}><CornerUpLeft size={13} /></IconButton> : null}
          <IconButton label="Add reaction" onClick={() => setPicking((p) => !p)}><SmilePlus size={13} /></IconButton>
          {picking ? (
            <div className="absolute top-7 z-10 flex gap-0.5 rounded-pill border border-line bg-surface p-1 shadow-lift">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} type="button" className="rounded-full px-1.5 py-0.5 text-base hover:bg-raised" aria-label={`React ${e}`} onClick={() => { react.mutate({ emoji: e, add: !mineReacted(e) }); setPicking(false); }}>{e}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-7 place-items-center rounded-full border border-line bg-surface text-muted shadow-lift hover:text-ink">
      {children}
    </button>
  );
}

function highlightMentions(text: string, agents: Map<string, Agent>): ReactNode {
  const names = [...agents.values()].map((a) => a.name).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(`(@(?:all|everyone|${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "gi");
  return text.split(pattern).map((part, i) => (i % 2 === 1 ? <strong key={i} className="rounded bg-honey-ink/15 px-0.5">{part}</strong> : part));
}

function groupMessages(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const m of messages) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.createdAt - prev.createdAt >= 0 && m.createdAt - prev.createdAt < GROUP_GAP_MS) {
      groups[groups.length - 1] = [...last, m];
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function Attachments({ message }: { message: Message }) {
  return (
    <ul className="mt-1.5 flex max-w-full flex-wrap gap-2" aria-label="Attachments">
      {message.attachments.map((a) => (
        <li key={a.id}>
          {IMAGE.has(a.mime) ? (
            <a href={api.fileUrl(a.id, true)} target="_blank" rel="noreferrer noopener" className="block overflow-hidden rounded-xl border border-line">
              <img src={api.fileUrl(a.id, true)} alt={a.filename} loading="lazy" width={220} height={150} className="h-[150px] w-[220px] object-cover" />
            </a>
          ) : (
            <a href={api.fileUrl(a.id)} className="flex items-center gap-2 rounded-xl border border-line bg-sunken px-3 py-2 text-xs transition-colors hover:border-line-strong">
              <FileText size={14} className="text-honey" aria-hidden />
              <span className="max-w-48 truncate">{a.filename}</span>
              <span className="text-faint">{Math.max(1, Math.round(a.size / 1024))} KB</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
