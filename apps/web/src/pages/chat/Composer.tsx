import { useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Square } from "lucide-react";
import type { Agent, MessagePage } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { ErrorNote } from "../../components/ui/Field.tsx";

interface ComposerProps {
  channelId: string;
  agent: Agent | undefined;
  working: boolean;
  onSent: () => void;
}

const MAX_LENGTH = 20000;

export function Composer({ channelId, agent, working, onSent }: ComposerProps) {
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  const send = useMutation({
    mutationFn: (body: string) => api.postMessage(channelId, body),
    onSuccess: (message) => {
      client.setQueryData<MessagePage>(qk.messages(channelId), (page) =>
        page && !page.messages.some((m) => m.id === message.id) ? { ...page, messages: [...page.messages, message] } : page,
      );
      setDraft("");
      onSent();
      area.current?.focus();
    },
  });
  const stop = useMutation({ mutationFn: () => api.stopAgent(agent?.id ?? "") });

  const submit = () => {
    const body = draft.trim();
    if (body && !send.isPending) send.mutate(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line p-3">
      <ErrorNote error={send.error ?? stop.error} />
      <div className="flex items-end gap-2 rounded-[1.4rem] border border-line bg-sunken p-1.5 pl-4 transition-colors focus-within:border-honey/60">
        <textarea
          ref={area}
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={agent ? `Message ${agent.name}` : "Message"}
          aria-label="Message"
          className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-[0.95rem] leading-relaxed placeholder:text-faint focus:outline-none"
        />
        {working ? (
          <button
            type="button"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            className="grid size-9 shrink-0 place-items-center rounded-full border border-err/50 text-err transition-colors hover:bg-err/15"
            aria-label="Stop the current turn"
            title="Stop the current turn"
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || send.isPending}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-honey text-honey-ink transition-[transform,opacity] hover:scale-105 active:scale-95 disabled:opacity-35 disabled:hover:scale-100"
          aria-label="Send"
        >
          <ArrowUp size={17} strokeWidth={2.6} />
        </button>
      </div>
      <p className="mt-1.5 px-3 text-[0.68rem] text-faint">Enter to send · Shift+Enter for a new line{working ? " · new messages wait for the current turn" : ""}</p>
    </div>
  );
}
