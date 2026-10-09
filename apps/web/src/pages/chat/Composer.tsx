import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CornerUpLeft, Square, X } from "lucide-react";
import type { Agent, Channel, Message, MessagePage } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { ErrorNote } from "../../components/ui/Field.tsx";
import { preview } from "../../lib/format.ts";

interface ComposerProps {
  channel: Channel;
  members: Agent[];
  replyTo: Message | null;
  onCancelReply: () => void;
  onSent: () => void;
}

const MAX_LENGTH = 20000;

/** Finds an "@partial" right before the caret, for mention autocomplete. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([\p{L}\p{N}_ .-]{0,30})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]!.toLowerCase() };
}

export function Composer({ channel, members, replyTo, onCancelReply, onSent }: ComposerProps) {
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const isGroup = channel.kind === "group";

  const mention = isGroup ? mentionQuery(draft, caret) : null;
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const options = [...members.map((a) => ({ id: a.id, name: a.name, agent: a })), { id: "all", name: "all", agent: undefined }];
    return options.filter((o) => o.name.toLowerCase().startsWith(mention.query)).slice(0, 6);
  }, [mention?.query, members]);

  const send = useMutation({
    mutationFn: (body: string) => api.postMessage(channel.id, body, replyTo?.id),
    onSuccess: (message) => {
      client.setQueryData<MessagePage>(qk.messages(channel.id), (page) =>
        page && !page.messages.some((m) => m.id === message.id) ? { ...page, messages: [...page.messages, message] } : page,
      );
      setDraft("");
      onSent();
      area.current?.focus();
    },
  });
  const working = members.filter((a) => a.state === "working");
  const stop = useMutation({ mutationFn: async () => { await Promise.all(working.map((a) => api.stopAgent(a.id))); } });

  const complete = (name: string) => {
    if (!mention) return;
    const next = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`;
    setDraft(next);
    const pos = mention.start + name.length + 2;
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const submit = () => {
    const body = draft.trim();
    if (body && !send.isPending) send.mutate(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        complete(suggestions[Math.min(highlight, suggestions.length - 1)]!.name);
        return;
      }
      if (e.key === "Escape") {
        setCaret(-1);
        return;
      }
    }
    if (e.key === "Escape" && replyTo) onCancelReply();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = isGroup ? `Message #${channel.title} — @mention to wake an agent` : `Message ${members[0]?.name ?? ""}`;

  return (
    <div className="relative border-t border-line p-3">
      <ErrorNote error={send.error ?? stop.error} />
      {suggestions.length ? (
        <ul role="listbox" aria-label="Mention suggestions" className="absolute bottom-full left-4 z-10 mb-1 w-64 overflow-hidden rounded-2xl border border-line bg-surface shadow-lift">
          {suggestions.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === highlight}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); complete(s.name); }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${i === highlight ? "bg-raised" : "hover:bg-raised/60"}`}>
                {s.agent ? <AgentAvatar seed={s.agent.avatarSeed} size={20} /> : <span className="grid size-5 place-items-center rounded-md bg-honey/20 text-[0.6rem] font-bold text-honey">ALL</span>}
                <span className="font-semibold">@{s.name}</span>
                {s.agent ? <span className="truncate text-xs text-muted">{s.agent.role}</span> : <span className="text-xs text-muted">wake everyone</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {replyTo ? (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-sunken px-3 py-1.5 text-xs text-muted">
          <CornerUpLeft size={12} aria-hidden /> Replying to <strong className="text-ink">{replyTo.authorName}</strong>: <span className="truncate">{preview(replyTo.body, 70)}</span>
          <button type="button" onClick={onCancelReply} className="ml-auto rounded-full p-0.5 hover:text-ink" aria-label="Cancel reply"><X size={12} /></button>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-[1.4rem] border border-line bg-sunken p-1.5 pl-4 transition-colors focus-within:border-honey/60">
        <textarea
          ref={area}
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setHighlight(0); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Message"
          aria-autocomplete={isGroup ? "list" : undefined}
          className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-[0.95rem] leading-relaxed placeholder:text-faint focus:outline-none"
        />
        {working.length ? (
          <button type="button" onClick={() => stop.mutate()} disabled={stop.isPending}
            className="grid size-9 shrink-0 place-items-center rounded-full border border-err/50 text-err transition-colors hover:bg-err/15"
            aria-label="Stop the current turn" title={`Stop ${working.map((a) => a.name).join(", ")}`}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : null}
        <button type="button" onClick={submit} disabled={!draft.trim() || send.isPending}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-honey text-honey-ink transition-[transform,opacity] hover:scale-105 active:scale-95 disabled:opacity-35 disabled:hover:scale-100" aria-label="Send">
          <ArrowUp size={17} strokeWidth={2.6} />
        </button>
      </div>
      <p className="mt-1.5 px-3 text-[0.68rem] text-faint">Enter to send · Shift+Enter for a new line{isGroup ? " · @ to mention" : ""}</p>
    </div>
  );
}
