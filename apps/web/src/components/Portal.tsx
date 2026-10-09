import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Hash, MessageSquareText, Search, Server } from "lucide-react";
import { api, qk } from "../app/api.ts";
import { preview, relativeTime } from "../lib/format.ts";

interface Item {
  readonly key: string;
  readonly group: "Agents" | "Chats" | "Workstations" | "Messages";
  readonly label: string;
  readonly detail: string;
  readonly go: () => void;
}

const ICONS = { Agents: Bot, Chats: Hash, Workstations: Server, Messages: MessageSquareText } as const;

/** ⌘/Ctrl+K: one search box over agents, chats, workstations and message text. */
export function Portal() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-pill border border-line bg-surface/70 px-3 py-1 text-xs text-muted transition-colors hover:border-honey/50 hover:text-ink" aria-label="Search everything">
        <Search size={13} aria-hidden /> <span className="max-sm:hidden">Search</span> <kbd className="rounded border border-line px-1 font-mono text-[0.65rem] max-sm:hidden">⌘K</kbd>
      </button>
      {open ? <PortalDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PortalDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels });
  const workstations = useQuery({ queryKey: qk.workstations, queryFn: api.workstations });
  const hits = useQuery({ queryKey: qk.search(debounced), queryFn: () => api.search(debounced), enabled: debounced.length >= 2 });

  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = (path: string) => {
    ref.current?.close();
    void navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const n = q.trim().toLowerCase();
    const has = (s: string) => s.toLowerCase().includes(n);
    const out: Item[] = [];
    for (const a of agents.data ?? []) if (!n || has(a.name) || has(a.role)) out.push({ key: `a${a.id}`, group: "Agents", label: a.name, detail: a.role || a.modelId, go: () => go(`/agents/${a.id}`) });
    for (const c of channels.data ?? []) if (!n || has(c.title ?? "")) out.push({ key: `c${c.id}`, group: "Chats", label: c.title ?? "Chat", detail: c.kind === "group" ? "group" : c.kind === "dm" ? "direct" : "between agents", go: () => go(`/chat/${c.id}`) });
    for (const w of workstations.data ?? []) if (!n || has(w.name) || has(w.osUser)) out.push({ key: `w${w.id}`, group: "Workstations", label: w.name, detail: w.osUser, go: () => go(`/workstations/${w.id}`) });
    if (debounced.length >= 2) {
      for (const h of hits.data ?? []) {
        out.push({
          key: `m${h.message.id}`, group: "Messages", label: preview(h.message.body, 90), detail: `${h.message.authorName} in ${h.channelTitle} · ${relativeTime(h.message.createdAt)}`,
          go: () => {
            client.removeQueries({ queryKey: qk.messages(h.message.channelId) });
            go(`/chat/${h.message.channelId}?m=${h.message.id}`);
          },
        });
      }
    }
    return out.slice(0, 40);
  }, [q, debounced, agents.data, channels.data, workstations.data, hits.data]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (items.length ? (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.go();
    }
  };

  let lastGroup = "";
  return (
    <dialog ref={ref} onClose={onClose} aria-label="Search" className="m-auto mt-[12vh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-lift backdrop:bg-black/60 backdrop:backdrop-blur-sm">
      <label className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Search size={18} className="text-honey" aria-hidden />
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKeyDown}
          placeholder="Search agents, chats, workstations and messages" aria-label="Search" role="combobox" aria-expanded aria-controls="portal-results"
          className="w-full bg-transparent text-base placeholder:text-faint focus:outline-none" />
        <kbd className="rounded border border-line px-1.5 font-mono text-[0.65rem] text-faint">esc</kbd>
      </label>
      <ul id="portal-results" role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const Icon = ICONS[item.group];
          return (
            <li key={item.key} role="option" aria-selected={i === active}>
              {header ? <p className="px-3 pt-3 pb-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-faint">{header}</p> : null}
              <button type="button" onMouseEnter={() => setActive(i)} onClick={item.go}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${i === active ? "bg-raised" : ""}`}>
                <Icon size={15} className="shrink-0 text-honey" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{item.label}</span>
                  <span className="block truncate text-xs text-muted">{item.detail}</span>
                </span>
              </button>
            </li>
          );
        })}
        {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted">{hits.isFetching ? "Searching…" : "Nothing found."}</li> : null}
      </ul>
    </dialog>
  );
}
