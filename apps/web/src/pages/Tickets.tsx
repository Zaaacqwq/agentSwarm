import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectView, TicketStatus, TicketView } from "@agentswarm/contracts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Empty, PageHead } from "../components/ui.tsx";
import { NewTicket } from "../components/NewTicket.tsx";
import { KIND_LABEL, MoveMenu, PRIORITY_LABEL, STATUS_LABEL, TicketCard, YOURS, moveTicket } from "../components/TicketCard.tsx";
import { navigate } from "../router.tsx";

const COLUMNS: readonly TicketStatus[] = ["backlog", "todo", "in_progress", "needs_you", "done"];

/** Filters live in the address, so a reload or a shared link keeps them. */
function useQuery(): [URLSearchParams, (key: string, value: string) => void] {
  const [query, setQuery] = useState(() => new URLSearchParams(location.search));
  useEffect(() => {
    const on = () => setQuery(new URLSearchParams(location.search));
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
    setQuery(next);
  };
  return [query, set];
}

export function TicketsPage() {
  const tickets = useResource<TicketView[]>("/tickets");
  const projects = useResource<ProjectView[]>("/projects");
  const [query, setQuery] = useQuery();
  const [creating, setCreating] = useState(false);
  const narrow = useMemo(() => matchMedia("(max-width: 760px)").matches, []);
  const view = query.get("view") ?? (narrow ? "list" : "board");
  useReconnect(tickets.reload);
  useLive((m) => {
    if (m.kind !== "ticket") return;
    tickets.set((prev) => {
      const rest = (prev ?? []).filter((x) => x.id !== m.ticket.id);
      // A deleted ticket comes as canceled without a mission, gone from the list on the next load.
      return [...rest, m.ticket];
    });
  });
  const q = (query.get("q") ?? "").trim().toLowerCase();
  const all = tickets.data ?? [];
  const shown = all.filter((t) =>
    (!q || `${t.key} ${t.title} ${t.description}`.toLowerCase().includes(q))
    && (!query.get("project") || t.projectId === query.get("project") || t.space === query.get("project"))
    && (!query.get("kind") || t.kind === query.get("kind"))
    && (!query.get("priority") || String(t.priority) === query.get("priority")));
  const columns = query.get("canceled") ? [...COLUMNS, "canceled" as const] : COLUMNS;
  const needYou = all.filter((t) => t.status === "needs_you").length;
  const working = all.filter((t) => t.status === "in_progress").length;
  return (
    <div className="stack">
      <PageHead title="Tickets"
        sub={<>{needYou ? <b className="needs-you">{needYou} need you</b> : "Nothing needs you"} · {working} in progress · {all.filter((t) => t.status === "todo").length} waiting to start</>}
        action={<button className="btn signal" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>{creating ? "Close" : "New ticket"}</button>} />
      {creating && <NewTicket onCreated={(t) => {
        setCreating(false);
        tickets.reload();
        navigate(`/tickets/${t.key}`);
      }} />}
      <div className="board-tools" role="search">
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === "board"} onClick={() => setQuery("view", "board")}>Board</button>
          <button aria-pressed={view === "list"} onClick={() => setQuery("view", "list")}>List</button>
        </div>
        <input type="search" aria-label="Search tickets" placeholder="Search: FRI-12, words…" value={query.get("q") ?? ""} onChange={(e) => setQuery("q", e.target.value)} />
        <select aria-label="Project" value={query.get("project") ?? ""} onChange={(e) => setQuery("project", e.target.value)}>
          <option value="">All projects</option>
          {projects.data?.filter((p) => p.kind === "github").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="sandbox">Sandbox</option>
          <option value="ideas">Ideas</option>
        </select>
        <select aria-label="Kind" value={query.get("kind") ?? ""} onChange={(e) => setQuery("kind", e.target.value)}>
          <option value="">Any kind</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Priority" value={query.get("priority") ?? ""} onChange={(e) => setQuery("priority", e.target.value)}>
          <option value="">Any priority</option>
          {[1, 2, 3, 4, 0].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <label className="row faint"><input type="checkbox" checked={Boolean(query.get("canceled"))} onChange={(e) => setQuery("canceled", e.target.checked ? "1" : "")} /> Canceled</label>
      </div>
      {tickets.data && all.length === 0 && !creating && <Empty>No tickets yet. Write down the first thing you want done: it waits in the backlog until you start it.</Empty>}
      {all.length > 0 && (view === "board" ? <Board tickets={shown} columns={columns} /> : <List tickets={shown} columns={columns} />)}
    </div>
  );
}

const byPlace = (a: TicketView, b: TicketView) => a.position - b.position;

/**
 * Columns of cards. Drag a ticket that has not started between Backlog and Todo (or onto Canceled), and up
 * and down to set the order; started ones move with their mission. Long-press on touch, Space on a keyboard.
 */
function Board({ tickets, columns }: { tickets: TicketView[]; columns: readonly TicketStatus[] }) {
  const [active, setActive] = useState<TicketView | null>(null);
  const [optimistic, setOptimistic] = useState<Map<string, { status: TicketStatus; position: number }>>(new Map());
  useEffect(() => setOptimistic(new Map()), [tickets]);
  const placed = tickets.map((t) => (optimistic.has(t.id) ? { ...t, ...optimistic.get(t.id)! } : t));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    // Space picks up and drops; Enter is left to the card's link (it opens the ticket).
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }),
  );
  const columnOf = (id: string): TicketStatus | null => (columns as readonly string[]).includes(id) ? id as TicketStatus : placed.find((t) => t.id === id)?.status ?? null;
  const onStart = (e: DragStartEvent) => setActive(placed.find((t) => t.id === e.active.id) ?? null);
  const onEnd = async (e: DragEndEvent) => {
    setActive(null);
    const t = placed.find((x) => x.id === e.active.id);
    const to = e.over ? columnOf(String(e.over.id)) : null;
    if (!t || !to) return;
    if (!YOURS.includes(to) || (t.missionId && to !== "canceled")) {
      if (to !== t.status) alert(t.missionId ? `${t.key} has started: its column follows its mission.` : `Drop it on Backlog or Todo; ${STATUS_LABEL[to]} follows the work.`);
      return;
    }
    const col = placed.filter((x) => x.status === to && x.id !== t.id).sort(byPlace);
    const overIndex = col.findIndex((x) => x.id === e.over!.id);
    const index = overIndex < 0 ? col.length : overIndex;
    const after = index > 0 ? col[index - 1]!.id : null;
    const before = index < col.length ? col[index]!.id : null;
    const position = ((after ? col[index - 1]!.position : (before ? col[index]!.position - 2 : 0)) + (before ? col[index]!.position : (after ? col[index - 1]!.position + 2 : 0))) / 2;
    setOptimistic(new Map(optimistic).set(t.id, { status: to, position }));
    if (!(await moveTicket(t, to as "backlog" | "todo" | "canceled", { after, before }))) setOptimistic(new Map());
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragEnd={(e) => void onEnd(e)} onDragCancel={() => setActive(null)}>
      <div className="board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(176px, 1fr))`, "--cols": columns.length } as CSSProperties}>
        {columns.map((c) => <Column key={c} status={c} tickets={placed.filter((t) => t.status === c).sort(byPlace)} />)}
      </div>
      <DragOverlay>{active ? <TicketCard t={active} dragging /> : null}</DragOverlay>
      <span id="drag-help" hidden>Press Space to pick a ticket up, the arrows to move it, Space to drop it, Escape to cancel.</span>
    </DndContext>
  );
}

function Column({ status, tickets }: { status: TicketStatus; tickets: TicketView[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section className={`column c-${status}${isOver ? " over" : ""}`} aria-label={STATUS_LABEL[status]}>
      <h2 className="column-head">{STATUS_LABEL[status]} <span className="faint">{tickets.length}</span></h2>
      <SortableContext id={status} items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ol className="column-list" ref={setNodeRef}>
          {tickets.map((t) => <SortableCard key={t.id} t={t} />)}
          {tickets.length === 0 && <li className="column-empty faint">{status === "todo" ? "Drop here to start" : status === "needs_you" ? "Nothing waits for you" : "—"}</li>}
        </ol>
      </SortableContext>
    </section>
  );
}

function SortableCard({ t }: { t: TicketView }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? "placeholder" : ""} {...attributes} {...listeners}
      aria-roledescription="Draggable ticket" aria-describedby="drag-help">
      <TicketCard t={t} />
    </li>
  );
}

/** Grouped by status: the phone's view, with the move menu instead of dragging. */
function List({ tickets, columns }: { tickets: TicketView[]; columns: readonly TicketStatus[] }) {
  return (
    <div className="stack">
      {columns.map((c) => {
        const rows = tickets.filter((t) => t.status === c).sort(byPlace);
        if (!rows.length) return null;
        return (
          <section key={c} className={`list-group c-${c}`} aria-label={STATUS_LABEL[c]}>
            <h2 className="column-head">{STATUS_LABEL[c]} <span className="faint">{rows.length}</span></h2>
            <ol className="ticket-list">
              {rows.map((t) => (
                <li key={t.id} className="ticket-row">
                  <TicketCard t={t} />
                  <MoveMenu t={t} />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
