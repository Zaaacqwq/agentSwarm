import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunEventView, RunView, TreeView } from "@agentswarm/contracts";
import { api } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Badge } from "./ui.tsx";

/** Tools whose output is a terminal's: shown as one. */
const TERMINAL_TOOLS = new Set(["ws_bash", "Bash", "shell"]);
const AGENT_HUES = ["var(--signal)", "var(--run)", "var(--ok)", "var(--warn)", "#8a5cf6", "#0e9384"];

export type ActivityItem =
  | { readonly kind: "tool"; readonly start: RunEventView; readonly end: RunEventView | undefined }
  | { readonly kind: "event"; readonly event: RunEventView };

/** One item per tool call (its start and, once there, its result), in order. */
export function pairTools(events: readonly RunEventView[]): ActivityItem[] {
  const ends = new Map(events.filter((e) => e.type === "tool_end").map((e) => [`${e.runId}:${String(e.data.id)}`, e]));
  return events.filter((e) => e.type !== "tool_end").map((e) => (e.type === "tool_start" ? { kind: "tool", start: e, end: ends.get(`${e.runId}:${String(e.data.id)}`) } : { kind: "event", event: e }));
}

export interface AgentLabel {
  readonly name: string;
  readonly hue: string;
}

/** A tool call as a card: one line (state, tool, what it was given, how long), the details on demand. */
export function ToolCard({ start, end, agent }: { start: RunEventView; end: RunEventView | undefined; agent?: AgentLabel }) {
  const s = start.data as Record<string, any>;
  const d = end?.data as Record<string, any> | undefined;
  const state = !d ? "running" : d.isError ? "failed" : "ok";
  const terminal = TERMINAL_TOOLS.has(String(s.name));
  return (
    <details className={`tool-card ${state}`} open={state === "failed"}>
      <summary>
        <span className={`tool-state ${state}`} aria-label={state === "running" ? "Running" : state === "failed" ? "Error" : "Done"} />
        {agent && <AgentChip agent={agent} />}
        <b className="tool-name">{String(s.name)}</b>
        <span className="tool-preview mono">{preview(s.args)}</span>
        {d?.ms ? <span className="faint">{(d.ms / 1000).toFixed(1)} s</span> : null}
      </summary>
      <div className="tool-body">
        <pre className={terminal ? "terminal" : "args"}>{terminal ? `$ ${String(s.args?.command ?? "")}` : details(s.args)}</pre>
        {d && <pre className={terminal ? "terminal" : "result"}>{String(d.output ?? "") || "(no output)"}</pre>}
      </div>
    </details>
  );
}

/** Everything that is not a tool call: what an agent said, messages, pushes, problems, status. */
export function EventLine({ e, agent }: { e: RunEventView; agent?: AgentLabel }) {
  const d = e.data as Record<string, any>;
  const chip = agent ? <AgentChip agent={agent} /> : null;
  switch (e.type) {
    case "user":
      return <Said who={d.from === "agentswarm" ? "agentSwarm" : "You"} chip={chip} text={String(d.text ?? "")} className="user" />;
    case "assistant":
      return <Said who="Agent" chip={chip} text={String(d.text || d.error || "")} className={`assistant${d.error ? " error" : ""}`} />;
    case "results":
      return <Said who="Sub-agents reported" chip={chip} text={String(d.text ?? "")} className="results" />;
    case "push":
      return <div className={`event push${d.status === "pushed" ? "" : " error"}`}><div className="who">{chip}Relay · <Badge status={String(d.status)} /></div><pre>{d.branch}{d.headSha ? ` @ ${String(d.headSha).slice(0, 10)}` : ""}{d.reason ? `\n${d.reason}` : ""}</pre></div>;
    case "error":
      return <div className="event error"><div className="who">{chip}Problem</div><pre>{d.message}</pre></div>;
    default:
      return <div className="status-line faint">{chip}{statusText(d)}</div>;
  }
}

/** Long text opens on demand: the first line says what it is. */
function Said({ who, chip, text, className }: { who: string; chip: React.ReactNode; text: string; className: string }) {
  const long = text.length > 280 || text.split("\n").length > 4;
  if (!long) return <div className={`event ${className}`}><div className="who">{chip}{who}</div><pre>{text}</pre></div>;
  return (
    <details className={`event ${className}`}>
      <summary className="who">{chip}{who}: <span className="said-first">{text.split("\n")[0]!.slice(0, 160)}</span></summary>
      <pre>{text}</pre>
    </details>
  );
}

function AgentChip({ agent }: { agent: AgentLabel }) {
  return <span className="agent-chip" style={{ borderColor: agent.hue, color: agent.hue }}>{agent.name}</span>;
}

export function statusText(d: Record<string, any>): string {
  if (d.status === "running") return `Started on ${d.workstation}`;
  if (d.status === "worktree") return `Worktree ready: ${d.branch} from ${d.base}`;
  if (d.status === "spawned") return `Spawned ${d.name} on ${d.branch}`;
  if (d.status === "waiting") return `Waiting for ${d.for?.length ?? 0} sub-agent${d.for?.length === 1 ? "" : "s"}; workstation released`;
  if (d.status === "pull_request") return `Opened pull request ${d.url}`;
  if (d.status === "cli") return `${d.runtime === "codex" ? "Codex" : "Claude Code"} session ${String(d.session ?? "").slice(0, 8)}${d.model ? ` · ${d.model}` : ""}`;
  if (d.status === "committed") return "agentSwarm committed what the CLI left uncommitted";
  return `Run ${d.status}${d.error ? `: ${d.error}` : ""}`;
}

function preview(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const first = args.command ?? args.path ?? args.file_path ?? args.query ?? args.url ?? args.name ?? Object.values(args)[0];
  const text = typeof first === "string" ? first : JSON.stringify(first ?? "");
  return text.split("\n")[0]!.slice(0, 120);
}

function details(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`).join("\n");
}

/**
 * Everything a tree's agents do, as one live feed: who did what, tool calls as cards. Follows the
 * newest activity unless you scroll up; filters to one agent; pages further back on request.
 */
export function TreeActivity({ treeId }: { treeId: string }) {
  const tree = useResource<TreeView>(`/trees/${treeId}`);
  const [events, setEvents] = useState<RunEventView[] | null>(null);
  const [more, setMore] = useState(true);
  const [only, setOnly] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const load = () => api<RunEventView[]>("GET", `/trees/${treeId}/events`).then((e) => {
    setEvents(e);
    setMore(e.length >= 400);
  }).catch(() => setEvents([]));
  useEffect(() => void load(), [treeId]);
  useReconnect(() => {
    void load();
    tree.reload();
  });
  const runIds = useMemo(() => new Set(tree.data?.nodes.map((n) => n.id) ?? []), [tree.data]);
  useLive((m) => {
    if (m.kind === "run" && m.run.treeId === treeId) {
      tree.set((prev) => (prev ? { ...prev, nodes: prev.nodes.some((n) => n.id === m.run.id) ? prev.nodes.map((n) => (n.id === m.run.id ? m.run : n)) : [...prev.nodes, m.run] } : prev));
    }
    if (m.kind === "event" && (runIds.has(m.event.runId) || tree.data?.nodes.length === 0)) {
      setEvents((prev) => (prev && !prev.some((e) => e.id === m.event.id) ? [...prev, m.event] : prev));
    }
  });
  const agents = useMemo(() => labels(tree.data?.nodes ?? []), [tree.data]);
  const items = pairTools((events ?? []).filter((e) => !only || e.runId === only));
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length, follow]);
  const earlier = async () => {
    const first = events?.[0];
    if (!first) return;
    const older = await api<RunEventView[]>("GET", `/trees/${treeId}/events?before=${first.id}`);
    setMore(older.length >= 400);
    setEvents((prev) => [...older, ...(prev ?? [])]);
  };
  const live = tree.data?.nodes.filter((n) => n.status === "running").length ?? 0;
  return (
    <section className="card stack" aria-labelledby="activity-head">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="activity-head">Live activity</h2>
        <div className="row">
          {live > 0 && <Badge status="running">{live} working</Badge>}
          <select aria-label="Agent" value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">All agents</option>
            {tree.data?.nodes.map((n) => <option key={n.id} value={n.id}>{agents.get(n.id)?.name}</option>)}
          </select>
        </div>
      </div>
      <div className="activity" ref={box} role="log" aria-live="polite" aria-label="Agent activity"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}>
        {more && events && events.length > 0 && <button className="btn ghost" onClick={() => void earlier()}>Show earlier activity</button>}
        {events === null ? <p className="faint">Loading…</p> : items.length === 0 ? <p className="faint">Nothing yet.</p> : items.map((item) => {
          const runId = item.kind === "tool" ? item.start.runId : item.event.runId;
          const agent = agents.get(runId);
          return item.kind === "tool"
            ? <ToolCard key={item.start.id} start={item.start} end={item.end} {...(agent ? { agent } : {})} />
            : <EventLine key={item.event.id} e={item.event} {...(agent ? { agent } : {})} />;
        })}
      </div>
      {!follow && <button className="btn ghost" onClick={() => setFollow(true)}>Jump to the latest</button>}
    </section>
  );
}

/** Each run gets its agent's name (reviews say so) and a steady colour. */
function labels(nodes: readonly RunView[]): Map<string, AgentLabel> {
  const out = new Map<string, AgentLabel>();
  nodes.forEach((n, i) => {
    const runtime = n.runtime === "claude_code" ? " · Claude Code" : n.runtime === "codex" ? " · Codex" : "";
    out.set(n.id, { name: `${n.agentName}${runtime}`, hue: AGENT_HUES[i % AGENT_HUES.length]! });
  });
  return out;
}
