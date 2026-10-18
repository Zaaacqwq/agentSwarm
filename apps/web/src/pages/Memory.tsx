import { useEffect, useState } from "react";
import type { HandbookProposalView, HandbookView, LessonScope, LessonVersionView, LessonView, ProjectView, Role } from "@agentswarm/contracts";
import { ago, api } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, Field, Form, PageHead } from "../components/ui.tsx";

// Kept here (not imported from the contracts' runtime) so the dashboard bundle stays free of the schema library.
const ROLES: readonly Role[] = ["lead", "researcher", "architect", "developer", "reviewer", "qa", "marketer"];
const ROLE_LABEL: Record<Role, string> = { lead: "Lead", researcher: "Researcher", architect: "Architect", developer: "Developer", reviewer: "Reviewer", qa: "QA", marketer: "Marketer" };
const SCOPE_LABEL: Record<LessonScope, string> = { team: "Whole team", project: "Project", role: "Role" };

/** What the team has learned (lessons) and how each role works (handbooks), R8. */
export function MemoryPage() {
  const [tab, setTab] = useState<"lessons" | "handbooks">(() => (new URLSearchParams(location.search).get("tab") === "handbooks" ? "handbooks" : "lessons"));
  const proposals = useResource<HandbookProposalView[]>("/handbook-proposals?status=open");
  const open = proposals.data?.length ?? 0;
  const pick = (t: "lessons" | "handbooks") => {
    setTab(t);
    history.replaceState(null, "", t === "lessons" ? "/memory" : "/memory?tab=handbooks");
  };
  return (
    <div className="stack">
      <PageHead title="Memory" sub={<>What earlier work taught the team, and how each role works.{open ? <> · <b className="needs-you">{open} handbook change{open === 1 ? "" : "s"} to decide</b></> : null}</>} />
      <div className="segmented" role="tablist" aria-label="Memory">
        <button role="tab" aria-selected={tab === "lessons"} aria-pressed={tab === "lessons"} onClick={() => pick("lessons")}>Lessons</button>
        <button role="tab" aria-selected={tab === "handbooks"} aria-pressed={tab === "handbooks"} onClick={() => pick("handbooks")}>Handbooks{open ? ` (${open})` : ""}</button>
      </div>
      {tab === "lessons" ? <Lessons /> : <Handbooks proposals={proposals.data ?? []} reload={proposals.reload} />}
    </div>
  );
}

function Lessons() {
  const lessons = useResource<LessonView[]>("/lessons");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const all = lessons.data ?? [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((l) => (showRetired || !l.retired) && (!scope || l.scope === scope)
    && words.every((w) => `${l.title} ${l.text} ${l.source ?? ""}`.toLowerCase().includes(w)));
  const pinned = all.filter((l) => l.pinned && !l.retired).length;
  return (
    <div className="stack">
      <div className="board-tools" role="search">
        <input type="search" aria-label="Search lessons" placeholder="Search lessons" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Every scope</option>
          {(Object.keys(SCOPE_LABEL) as LessonScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
        </select>
        <label className="row faint"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Retired</label>
        <button className="btn signal" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "New lesson"}</button>
      </div>
      <p className="faint">{pinned} of 8 pinned: every agent reads those. The rest come up when they fit a ticket, and agents can search them with recall.</p>
      {adding && <NewLesson onDone={() => {
        setAdding(false);
        lessons.reload();
      }} />}
      {lessons.data && shown.length === 0 && <Empty>{all.length ? "No lesson matches." : "No lessons yet. Leads record them at retrospectives; you can write your own."}</Empty>}
      <ol className="lesson-list">
        {shown.map((l) => <li key={l.id}><Lesson l={l} onChange={lessons.reload} /></li>)}
      </ol>
    </div>
  );
}

function scopeText(l: LessonView): string {
  return l.scope === "project" ? l.projectName ?? "a project" : l.scope === "role" ? `${ROLE_LABEL[l.role!]}s` : "Whole team";
}

function Lesson({ l, onChange }: { l: LessonView; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(l.title);
  const [text, setText] = useState(l.text);
  const [versions, setVersions] = useState<LessonVersionView[] | null>(null);
  const patch = (body: Record<string, unknown>) => api("PATCH", `/lessons/${l.id}`, body).then(onChange).catch((e: Error) => alert(e.message));
  const fromAgent = l.author !== "you";
  return (
    <article className={`lesson${l.pinned ? " pinned" : ""}${l.retired ? " retired" : ""}`} aria-label={l.title}>
      <header className="lesson-top">
        {l.pinned && <span className="pin" aria-label="Pinned">Pinned</span>}
        <span className="kind-tag">{scopeText(l)}</span>
        <span className={fromAgent ? "faint agent-note" : "faint"}>{fromAgent ? `advice from ${l.author}${l.source ? ` after ${l.source}` : ""}` : "yours"}</span>
        <span className="faint">used {l.uses}×{l.lastUsedAt ? `, last ${ago(l.lastUsedAt)}` : ""}</span>
      </header>
      {editing ? (
        <Form submit="Save" onSubmit={async () => {
          await api("PATCH", `/lessons/${l.id}`, { title, text });
          setEditing(false);
          onChange();
        }}>
          <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} /></Field>
          <Field label="Lesson" hint="Saved as yours: agents read it as a requirement."><textarea value={text} onChange={(e) => setText(e.target.value)} required maxLength={1000} style={{ minHeight: 90 }} /></Field>
        </Form>
      ) : (
        <>
          <h3 className="lesson-title">{l.title}</h3>
          <p className="pre">{l.text}</p>
        </>
      )}
      <footer className="row">
        {!l.retired && <button className="btn ghost small" onClick={() => void patch({ pinned: !l.pinned })}>{l.pinned ? "Unpin" : "Pin"}</button>}
        {!editing && <button className="btn ghost small" onClick={() => setEditing(true)}>Edit</button>}
        <button className="btn ghost small" onClick={() => void patch({ retired: !l.retired })}>{l.retired ? "Bring back" : "Retire"}</button>
        <button className="btn ghost small" onClick={() => (versions ? setVersions(null) : api<LessonVersionView[]>("GET", `/lessons/${l.id}/versions`).then(setVersions))}>{versions ? "Hide history" : "History"}</button>
      </footer>
      {versions && (
        <ol className="plain history-list">
          {versions.length === 0 && <li className="faint">No earlier versions.</li>}
          {versions.map((v) => <li key={v.id} className="faint"><b>{v.title}</b> · {v.author === "you" ? "yours" : v.author} · {ago(v.createdAt)}<p className="pre">{v.text}</p></li>)}
        </ol>
      )}
    </article>
  );
}

function NewLesson({ onDone }: { onDone: () => void }) {
  const projects = useResource<ProjectView[]>("/projects");
  const [scope, setScope] = useState<LessonScope>("team");
  const [projectId, setProjectId] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  useEffect(() => void (!projectId && projects.data?.[0] && setProjectId(projects.data[0].id)), [projects.data, projectId]);
  return (
    <section className="card" aria-label="New lesson">
      <Form submit="Keep this lesson" onSubmit={async () => {
        await api("POST", "/lessons", { scope, title, text, ...(scope === "project" ? { projectId } : {}), ...(scope === "role" ? { role } : {}) });
        onDone();
      }}>
        <div className="grid">
          <Field label="For">
            <select value={scope} onChange={(e) => setScope(e.target.value as LessonScope)}>
              {(Object.keys(SCOPE_LABEL) as LessonScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
          </Field>
          {scope === "project" && (
            <Field label="Project">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
          {scope === "role" && (
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label="Title" hint="One line someone would search for."><input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} placeholder="betterUWWorks: dev servers on port 3100, never 3000" /></Field>
        <Field label="Lesson"><textarea value={text} onChange={(e) => setText(e.target.value)} required maxLength={1000} style={{ minHeight: 90 }} /></Field>
      </Form>
    </section>
  );
}

function Handbooks({ proposals, reload }: { proposals: HandbookProposalView[]; reload: () => void }) {
  const books = useResource<HandbookView[]>("/handbooks");
  const [role, setRole] = useState<Role>("lead");
  const book = books.data?.find((b) => b.role === role);
  return (
    <div className="stack">
      {proposals.length > 0 && (
        <section className="card stack gate-card" aria-labelledby="proposals-head">
          <h2 id="proposals-head">Changes agents propose</h2>
          {proposals.map((p) => <Proposal key={p.id} p={p} current={books.data?.find((b) => b.role === p.role)?.text ?? ""} onDone={() => {
            reload();
            books.reload();
          }} />)}
        </section>
      )}
      <div className="handbooks">
        <nav className="role-list" aria-label="Roles">
          {ROLES.map((r) => {
            const b = books.data?.find((x) => x.role === r);
            return <button key={r} aria-pressed={r === role} onClick={() => setRole(r)}>{ROLE_LABEL[r]}{b && !b.isDefault ? <span className="faint"> · edited</span> : null}</button>;
          })}
        </nav>
        {book && <HandbookEditor key={`${book.role}:${book.updatedAt}`} book={book} onSaved={books.reload} />}
      </div>
    </div>
  );
}

function HandbookEditor({ book, onSaved }: { book: HandbookView; onSaved: () => void }) {
  const [text, setText] = useState(book.text);
  const [peek, setPeek] = useState<{ id: number; text: string } | null>(null);
  return (
    <section className="card stack" aria-label={`Handbook: ${ROLE_LABEL[book.role]}`}>
      <p className="faint">Every {book.role === "qa" ? "QA" : ROLE_LABEL[book.role].toLowerCase()} reads this in its instructions. {book.isDefault ? "agentSwarm's starting text." : `Changed ${ago(book.updatedAt)} by ${book.updatedBy.startsWith("usr_") ? "you" : book.updatedBy}.`}</p>
      <Form submit="Save handbook" onSubmit={async () => {
        await api("PUT", `/handbooks/${book.role}`, { text });
        onSaved();
      }}>
        <Field label={`${ROLE_LABEL[book.role]} handbook`} hint={`${text.length} of 4000 characters. Plain instructions, one per line, work best.`}>
          <textarea className="mono handbook-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required />
        </Field>
      </Form>
      {book.versions.length > 0 && (
        <details>
          <summary className="mini">Earlier versions ({book.versions.length})</summary>
          <ol className="plain history-list">
            {book.versions.map((v) => (
              <li key={v.id} className="faint">
                {v.author === "agentSwarm" ? "starting text" : v.author.startsWith("usr_") ? "yours" : v.author} · {ago(v.createdAt)}{" "}
                <button className="btn ghost small" onClick={() => (peek?.id === v.id ? setPeek(null) : api<{ text: string }>("GET", `/handbooks/${book.role}/versions/${v.id}`).then((r) => setPeek({ id: v.id, text: r.text })))}>{peek?.id === v.id ? "Hide" : "Show"}</button>{" "}
                <button className="btn ghost small" onClick={() => confirm("Go back to this version? The current text is kept as a version.") && api("POST", `/handbooks/${book.role}/versions/${v.id}/restore`, {}).then(onSaved).catch((e: Error) => alert(e.message))}>Restore</button>
                {peek?.id === v.id && <pre className="pre handbook-peek">{peek.text}</pre>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function Proposal({ p, current, onDone }: { p: HandbookProposalView; current: string; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(`${current}\n${p.change}`);
  const decide = (body: Record<string, unknown>) => api("POST", `/handbook-proposals/${p.id}`, body).then(onDone).catch((e: Error) => alert(e.message));
  return (
    <article className="proposal stack" aria-label={`Proposal for the ${ROLE_LABEL[p.role]} handbook`}>
      <p className="faint">For the <b>{ROLE_LABEL[p.role]}</b> handbook · {p.author}{p.source ? ` after ${p.source}` : ""} · {ago(p.createdAt)}</p>
      <pre className="pre proposal-change">{p.change}</pre>
      <p><span className="faint">Why: </span>{p.why}</p>
      {editing ? (
        <Form submit="Accept with my edits" onSubmit={async () => decide({ accept: true, text })}>
          <Field label="The handbook as it will be"><textarea className="mono handbook-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required /></Field>
        </Form>
      ) : (
        <div className="row">
          <button className="btn signal small" onClick={() => void decide({ accept: true })}>Accept</button>
          <button className="btn ghost small" onClick={() => setEditing(true)}>Edit, then accept</button>
          <button className="btn ghost small" onClick={() => void decide({ accept: false })}>Reject</button>
        </div>
      )}
    </article>
  );
}
