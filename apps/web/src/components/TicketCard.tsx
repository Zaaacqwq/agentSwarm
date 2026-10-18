import type { MouseEvent } from "react";
import type { MissionKind, TicketNeed, TicketStatus, TicketView } from "@agentswarm/contracts";
import { api, money } from "../api.ts";
import { navigate } from "../router.tsx";
import { STAGE_LABEL } from "./StageRail.tsx";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: "Backlog", todo: "Todo", in_progress: "In progress", needs_you: "Needs you", done: "Done", canceled: "Canceled",
};
export const KIND_LABEL: Record<MissionKind, string> = { feature: "Feature", bug: "Bug", research: "Research", experiment: "Experiment" };
export const PRIORITY_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
export const NEED_LABEL: Record<TicketNeed, string> = { answer: "Answer the lead", approve: "Approve the plan", merge: "Merge the PR", failed: "Stopped: needs you" };
/** Columns you can drop a ticket into yourself; the others follow its mission. */
export const YOURS: readonly TicketStatus[] = ["backlog", "todo", "canceled"];

/** Four bars, filled by urgency (none: an empty outline); urgent is the signal colour. */
export function PriorityMark({ p }: { p: number }) {
  const label = PRIORITY_LABEL[p] ?? "No priority";
  return (
    <span className={`prio p${p}`} role="img" aria-label={label} title={label}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={p !== 0 && i <= 5 - p ? "on" : ""} />)}
    </span>
  );
}

export function openTicket(e: MouseEvent, key: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(`/tickets/${key}`);
}

/** Moves a ticket to one of your columns; returns false (after saying why) when it cannot. */
export async function moveTicket(t: TicketView, status: "backlog" | "todo" | "canceled", place: { after?: string | null; before?: string | null } = {}): Promise<boolean> {
  if (status === "canceled" && t.missionId && !confirm(`Stop ${t.key}? Its agents are cancelled.`)) return false;
  if (status === "todo" && t.createdBy !== "you" && !confirm(`${t.key} was written by ${t.createdBy}, an agent. Start it?`)) return false;
  try {
    await api("POST", `/tickets/${t.key}/move`, { status, ...place });
    return true;
  } catch (e) {
    alert((e as Error).message);
    return false;
  }
}

/** One ticket: what it is, where it stands, and what it needs from you. */
export function TicketCard({ t, dragging = false }: { t: TicketView; dragging?: boolean }) {
  const started = Boolean(t.missionId);
  return (
    <article className={`ticket-card k-${t.kind}${t.need ? " attention" : ""}${dragging ? " dragging" : ""}`} aria-label={`${t.key} ${t.title}`}>
      <header className="ticket-top">
        <PriorityMark p={t.priority} />
        <span className="mono ticket-key">{t.key}</span>
        <span className={`kind-tag k-${t.kind}`}>{KIND_LABEL[t.kind]}</span>
        {t.attachments.length > 0 && <span className="faint" title={`${t.attachments.length} picture(s)`} aria-label={`${t.attachments.length} pictures`}>▣ {t.attachments.length}</span>}
      </header>
      <a className="ticket-title" href={`/tickets/${t.key}`} onClick={(e) => openTicket(e, t.key)}>{t.title}</a>
      {t.need && <p className="ticket-need">{NEED_LABEL[t.need]}</p>}
      <footer className="ticket-foot">
        <span className="faint">{t.projectName ?? (t.space === "sandbox" ? "Sandbox" : t.space === "ideas" ? "Ideas" : "—")}</span>
        {t.status === "todo" && t.queuePosition !== null && <span className="faint">{t.queuePosition === 0 ? "next to start" : `${t.queuePosition} ahead`}</span>}
        {started && t.stage && t.status !== "done" && t.status !== "canceled" && <span className="faint">{STAGE_LABEL[t.stage]}</span>}
        {t.working > 0 && <span className="working" aria-label={`${t.working} agents working`}>{t.working} working</span>}
        {started && t.costUsd > 0 && <span className="faint">{money(t.costUsd)}</span>}
        {t.createdBy !== "you" && <span className="faint">filed by {t.createdBy}</span>}
      </footer>
    </article>
  );
}

/** Your columns as a small menu: the way to move a ticket on a phone (and without dragging). */
export function MoveMenu({ t }: { t: TicketView }) {
  const options = (t.missionId ? (t.status === "in_progress" || t.status === "needs_you" ? ["canceled"] : []) : YOURS.filter((s) => s !== t.status)) as ("backlog" | "todo" | "canceled")[];
  if (!options.length) return null;
  return (
    <select className="move-menu" aria-label={`Move ${t.key}`} value="" onChange={(e) => void moveTicket(t, e.target.value as "backlog" | "todo" | "canceled")}>
      <option value="" disabled>Move…</option>
      {options.map((s) => <option key={s} value={s}>{s === "canceled" && t.missionId ? "Stop" : STATUS_LABEL[s]}</option>)}
    </select>
  );
}
