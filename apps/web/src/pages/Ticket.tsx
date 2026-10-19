import { useState } from "react";
import type { TicketEventView, TicketView } from "@agentswarm/contracts";
import { api, ago, money, upload, when } from "../api.ts";
import { useLive, useReconnect, useResource } from "../live.ts";
import { Field, Form, PageHead } from "../components/ui.tsx";
import { KIND_LABEL, MoveMenu, NEED_LABEL, PRIORITY_LABEL, PriorityMark, STATUS_LABEL } from "../components/TicketCard.tsx";
import { MissionDetails, StopMission } from "./Mission.tsx";
import { ReviewPanel } from "../components/Review.tsx";
import { Outputs, TicketFiles, WaitsFor } from "../components/Files.tsx";
import { Link, navigate } from "../router.tsx";

/** One ticket: your words and pictures, then (once it starts) its mission: conversation, gates, agents, activity. */
export function TicketPage({ ticketKey }: { ticketKey: string }) {
  const ticket = useResource<TicketView>(`/tickets/${ticketKey}`);
  const events = useResource<TicketEventView[]>(`/tickets/${ticketKey}/events`);
  useReconnect(() => {
    ticket.reload();
    events.reload();
  });
  useLive((m) => {
    if (m.kind === "ticket_removed" && m.id === ticket.data?.id) navigate("/");
    if (m.kind === "ticket" && (m.ticket.key === ticketKey || m.ticket.id === ticket.data?.id)) {
      // Moved to another project: it has a new key and address.
      if (m.ticket.key !== ticketKey) navigate(`/tickets/${m.ticket.key}`);
      ticket.set(() => m.ticket);
      events.reload();
    }
  });
  if (!ticket.data) return ticket.error ? <p className="error">{ticket.error}</p> : null;
  const t = ticket.data;
  const open = t.status === "in_progress" || t.status === "needs_you";
  return (
    <div className="stack">
      <PageHead title={t.title}
        sub={<>
          <span className="mono">{t.key}</span> · <span className={t.need ? "needs-you" : "muted"}>{t.need ? NEED_LABEL[t.need] : STATUS_LABEL[t.status]}</span>
          {" · "}{t.projectName ?? (t.space === "sandbox" ? "Sandbox" : "Ideas")}{t.external && (/^https:\/\//.test(t.external.url) ? <> · from <a href={t.external.url} target="_blank" rel="noreferrer">{t.external.key} ↗</a></> : <> · from {t.external.key}</>)}
        </>}
        action={t.missionId ? (open ? <StopMission id={t.missionId} label="Stop" /> : undefined) : <MoveMenu t={t} />} />
      {t.createdBy !== "you" && (
        <div className="card warn-card" role="note">
          <b>Written by {t.createdBy}, an agent</b>{t.fromTicket ? <> while working on <Link to={`/tickets/${t.fromTicket}`}>{t.fromTicket}</Link></> : null}, not by you.
          Read it before you start it: its lead is told the words are not yours.
        </div>
      )}
      <div className="split">
        <section className="card stack" aria-labelledby="ask-head">
          <h2 id="ask-head">What you asked</h2>
          {t.missionId ? <p className="pre quote">{t.description || "(no details)"}</p> : <EditTicket t={t} />}
          <Pictures t={t} />
          <TicketFiles t={t} />
        </section>
        <aside className="card stack" aria-label="Ticket facts">
          <dl className="facts">
            <dt>Status</dt><dd>{STATUS_LABEL[t.status]}{t.status === "todo" && t.queuePosition !== null ? ` (${t.queuePosition === 0 ? "next to start" : `${t.queuePosition} ahead`})` : ""}</dd>
            <dt>Kind</dt><dd>{KIND_LABEL[t.kind]}</dd>
            <dt>Priority</dt><dd className="row"><PriorityMark p={t.priority} /> {PRIORITY_LABEL[t.priority]}</dd>
            {t.missionId && <><dt>Cost</dt><dd>{money(t.costUsd)}</dd></>}
            <dt>Created</dt><dd>{when(t.createdAt)}{t.createdBy !== "you" ? ` by ${t.createdBy}` : ""}</dd>
            {t.fromTicket && <><dt>From</dt><dd><Link to={`/tickets/${t.fromTicket}`}>{t.fromTicket}</Link></dd></>}
            {t.startedAt && <><dt>Started</dt><dd>{when(t.startedAt)}</dd></>}
            {t.endedAt && <><dt>Ended</dt><dd>{when(t.endedAt)}</dd></>}
          </dl>
          {t.status === "done" && (t.kind === "research" || t.kind === "experiment") && <Promote t={t} />}
          <History events={events.data ?? []} />
        </aside>
      </div>
      {t.missionId && <Outputs t={t} />}
      {t.missionId && <ReviewPanel t={t} />}
      {t.missionId && <MissionDetails id={t.missionId} hideIntent />}
    </div>
  );
}

/** Before it starts, it is yours to change; after, you talk to its lead. */
function EditTicket({ t }: { t: TicketView }) {
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description);
  const [priority, setPriority] = useState(t.priority);
  const [waits, setWaits] = useState<string[]>([...t.blockedBy]);
  const changed = title !== t.title || description !== t.description || priority !== t.priority || waits.join() !== t.blockedBy.join();
  return (
    <Form submit="Save" onSubmit={async () => void (await api("PATCH", `/tickets/${t.key}`, { title, description, priority, blockedBy: waits }))}>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
      <Field label="Details"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} style={{ minHeight: 120 }} /></Field>
      <Field label="Priority">
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
          {[1, 2, 3, 4, 0].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
      </Field>
      <Field label="Waits for" hint="It starts only once these tickets are done.">
        <WaitsFor self={t.key} value={waits} onChange={setWaits} />
      </Field>
      {!changed && <p className="faint">It waits in {STATUS_LABEL[t.status].toLowerCase()} until {t.status === "backlog" ? "you move it to Todo" : t.blocked ? `${t.blockedBy.join(", ")} ${t.blockedBy.length === 1 ? "is" : "are"} done` : "a slot is free"}.</p>}
      <p className="row">
        <button type="button" className="btn ghost small" onClick={() => confirm(`Delete ${t.key}?`) && api("DELETE", `/tickets/${t.key}`).then(() => navigate("/tickets")).catch((e: Error) => alert(e.message))}>Delete</button>
      </p>
    </Form>
  );
}

function Pictures({ t }: { t: TicketView }) {
  const fixed = Boolean(t.missionId);
  if (fixed && !t.attachments.length) return null;
  return (
    <div className="stack">
      <h3 className="mini">Pictures</h3>
      {t.attachments.length > 0 && (
        <ul className="picture-strip">
          {t.attachments.map((a) => (
            <li key={a.id}>
              <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} width={a.width} height={a.height} loading="lazy" /></a>
              {!fixed && <button className="btn ghost small" aria-label={`Remove ${a.name}`} onClick={() => api("DELETE", `/tickets/${t.key}/attachments/${a.id}`).catch((e: Error) => alert(e.message))}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!fixed && t.attachments.length < 6 && (
        <label className="btn ghost small file-pick">
          Add a picture
          <input type="file" accept="image/jpeg,image/png,image/heic,image/heif" onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) await upload(`/tickets/${t.key}/attachments`, file, file.name).catch((err: Error) => alert(err.message));
          }} />
        </label>
      )}
      {fixed && <p className="faint">The lead saw {t.attachments.length === 1 ? "it" : "them"} when it started{t.commitAttachments ? "; they are in the mission's documents (request/)" : ""}.</p>}
    </div>
  );
}

/** 立项: the idea or experiment becomes a repository, a project and a feature ticket. */
function Promote({ t }: { t: TicketView }) {
  const [repo, setRepo] = useState("");
  return (
    <section className="stack" aria-labelledby="promote-head">
      <h3 id="promote-head" className="mini">Make it a project (立项)</h3>
      <p className="faint">A private GitHub repository starts from what this {t.kind === "experiment" ? "experiment" : "research"} produced, and a feature ticket goes to Todo to build it.</p>
      <Form submit="Make it a project" onSubmit={async () => {
        const next = await api<TicketView>("POST", `/tickets/${t.key}/promote`, repo.trim() ? { repo: repo.trim() } : {});
        navigate(`/tickets/${next.key}`);
      }}>
        <Field label="Repository (optional)" hint="Leave empty to create one; or name an empty repository you made (owner/name).">
          <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="you/new-project" pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" />
        </Field>
      </Form>
    </section>
  );
}

const EVENT_TEXT: Record<TicketEventView["kind"], (d: Record<string, unknown>) => string> = {
  created: (d) => `created${d.from ? " from another ticket" : ""}${d.external ? ` (imported from ${String(d.external)})` : ""}`,
  edited: (d) => `edited${d.was ? ` (was ${String(d.was)})` : ""}`,
  status: (d) => `${STATUS_LABEL[d.from as TicketView["status"]] ?? d.from} → ${STATUS_LABEL[d.to as TicketView["status"]] ?? d.to}${d.reason ? `: ${String(d.reason)}` : ""}`,
  started: () => "started",
  ended: (d) => (d.to === "done" ? "done" : "stopped"),
  attachment: (d) => (d.file ? `added a file (${String(d.file)})` : d.removedFile ? `removed a file (${String(d.removedFile)})` : d.added ? `added a picture (${String(d.added)})` : "removed a picture"),
  promoted: (d) => (d.ticket ? `became a project: ${String(d.repo)} (${String(d.ticket)})` : `repository created: ${String(d.repo)}`),
  retried: (d) => `started again${d.worker && d.worker !== "native" ? ` with ${String(d.worker)}` : ""}`,
  sent_back: (d) => `sent back with ${String(d.comments)} comment(s)`,
  kept: (d) => `kept as ${String(d.repo)}`,
  dropped: () => "dropped",
  cleaned: () => "cleaned up after a week",
};

function History({ events }: { events: TicketEventView[] }) {
  if (!events.length) return null;
  return (
    <details className="history">
      <summary className="mini">History ({events.length})</summary>
      <ol className="plain">
        {events.map((e) => <li key={e.id} className="faint"><b>{e.actor === "agentswarm" ? "agentSwarm" : e.actor.startsWith("usr_") ? "You" : e.actor}</b> {EVENT_TEXT[e.kind](e.data)} · {ago(e.createdAt)}</li>)}
      </ol>
    </details>
  );
}
