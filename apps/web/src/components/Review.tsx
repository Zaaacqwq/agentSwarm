import { useEffect, useState } from "react";
import type { DiffFileView, ReviewComment, TicketDiffView, TicketView } from "@agentswarm/contracts";
import { api, when } from "../api.ts";
import { useResource } from "../live.ts";
import { Field } from "./ui.tsx";

type Line = { kind: "hunk" | "ctx" | "add" | "del"; text: string; old: number | null; new: number | null };

/** A unified diff's hunks as lines with their old and new numbers. */
export function diffLines(patch: string): Line[] {
  const out: Line[] = [];
  let o = 0;
  let n = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hunk", text: raw, old: null, new: null });
    } else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), old: null, new: n++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: o++, new: null });
    else if (raw.startsWith(" ")) out.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
  }
  return out;
}

const keyOf = (path: string, line: number) => `${path}:${line}`;

/**
 * Looking at what a ticket produced (R10, after Vibe Kanban and Ateam): the change file by file, comments on its lines
 * sent back to the lead together, and what you decide: merge or retry a change; keep, finish or drop a local result.
 */
export function ReviewPanel({ t }: { t: TicketView }) {
  const waiting = t.status === "review";
  const diff = useResource<TicketDiffView>(t.missionId ? `/tickets/${t.key}/diff` : null);
  // The lead pushes as it works: what you see follows each stage and each return to review.
  useEffect(() => {
    diff.reload();
  }, [t.stage, t.status]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled: ReviewComment[] = [
    ...Object.entries(comments).filter(([, text]) => text.trim()).map(([k, text]) => {
      const at = k.lastIndexOf(":");
      return { path: k.slice(0, at), line: Number(k.slice(at + 1)), text: text.trim() };
    }),
    ...(general.trim() ? [{ text: general.trim() }] : []),
  ];
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      await api("POST", `/tickets/${t.key}/${path}`, body);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const files = diff.data?.files ?? [];
  const local = t.kind === "newproject" || t.kind === "quick";
  return (
    <section className="card stack review" aria-labelledby="review-head">
      <div className="row spread">
        <h2 id="review-head">{local ? "What it made" : "The change"}</h2>
        {diff.data && <span className="faint mono">{diff.data.branch} → {diff.data.base}</span>}
      </div>
      {waiting && (
        <div className="review-actions" role="group" aria-label="Decide">
          {t.kind === "change" && t.prUrl && (
            <button className="btn signal" disabled={busy} onClick={() => confirm(`Merge the pull request of ${t.key} into the default branch?`) && void act("merge")}>Merge</button>
          )}
          {local && <Keep t={t} busy={busy} act={act} />}
          {t.kind === "quick" && <button className="btn ghost" disabled={busy} onClick={() => void act("finish")}>Done</button>}
          {local && <button className="btn ghost" disabled={busy} onClick={() => confirm(`Drop ${t.key}? Its local repository is removed.`) && void act("drop")}>Drop</button>}
          {t.prUrl && <a className="btn ghost" href={t.prUrl} target="_blank" rel="noreferrer">On GitHub ↗</a>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {diff.error && <p className="faint">{diff.error}</p>}
      {diff.data && files.length === 0 && <p className="faint">No changes yet.</p>}
      {files.length > 0 && (
        <p className="faint">{files.length} file{files.length === 1 ? "" : "s"}, +{files.reduce((a, f) => a + f.additions, 0)} −{files.reduce((a, f) => a + f.deletions, 0)}{diff.data?.truncated ? " (too big to show every line)" : ""}. {waiting ? "Click a line to comment on it." : ""}</p>
      )}
      <ul className="diff-files">
        {files.map((f) => (
          <li key={f.path}>
            <DiffFile f={f} canComment={waiting} comments={comments} onComment={(line, text) => setComments((c) => ({ ...c, [keyOf(f.path, line)]: text }))} />
          </li>
        ))}
      </ul>
      {waiting && (
        <div className="stack tight">
          <Field label="A comment on the whole (optional)">
            <textarea value={general} onChange={(e) => setGeneral(e.target.value)} maxLength={2000} style={{ minHeight: 60 }} />
          </Field>
          <div className="row">
            <button className="btn" disabled={busy || filled.length === 0} onClick={async () => {
              if (await act("send-back", { comments: filled })) {
                setComments({});
                setGeneral("");
              }
            }}>Send back{filled.length ? ` with ${filled.length} comment${filled.length === 1 ? "" : "s"}` : ""}</button>
            {t.kind === "change" && <Retry t={t} busy={busy} act={act} />}
          </div>
        </div>
      )}
      {!waiting && t.kind === "change" && (t.status === "in_progress" || t.status === "needs_you") && <Retry t={t} busy={busy} act={act} />}
      {t.attempts.length > 0 && (
        <div className="stack tight">
          <h3 className="mini">Earlier attempts</h3>
          <ol className="attempts">
            {t.attempts.map((a) => (
              <li key={a.missionId}>
                {when(a.at)}: stopped{a.worker !== "native" ? `, retried with ${a.worker === "claude_code" ? "Claude Code" : "Codex"}` : ""}
                {a.note ? ` (“${a.note}”)` : ""}{a.prUrl ? <> · <a href={a.prUrl} target="_blank" rel="noreferrer">its pull request ↗</a></> : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function DiffFile({ f, canComment, comments, onComment }: { f: DiffFileView; canComment: boolean; comments: Record<string, string>; onComment: (line: number, text: string) => void }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const lines = diffLines(f.patch);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="diff-file">
      <summary>
        <span className={`diff-status s-${f.status}`}>{f.status}</span> <span className="mono">{f.oldPath ? `${f.oldPath} → ` : ""}{f.path}</span>
        <span className="faint"> +{f.additions} −{f.deletions}</span>
      </summary>
      {f.binary ? <p className="faint">A binary file{/\.(jpe?g|png)$/i.test(f.path) ? " (a picture)" : ""}.</p> : (
        <table className="diff">
          <tbody>
            {lines.map((l, i) => {
              const k = l.new !== null ? keyOf(f.path, l.new) : null;
              const comment = k ? comments[k] : undefined;
              const clickable = canComment && l.new !== null;
              return [
                <tr key={i} className={`d-${l.kind}${clickable ? " commentable" : ""}`} onClick={clickable ? () => setEditing(l.new) : undefined}>
                  <td className="ln">{l.old ?? ""}</td>
                  <td className="ln">{l.new ?? ""}</td>
                  <td className="code"><span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text}</td>
                </tr>,
                (editing === l.new && l.new !== null) || comment ? (
                  <tr key={`c${i}`} className="d-comment">
                    <td colSpan={3}>
                      {editing === l.new ? (
                        <div className="stack tight">
                          <textarea autoFocus aria-label={`Comment on ${f.path} line ${l.new}`} defaultValue={comment ?? ""} maxLength={2000}
                            onBlur={(e) => {
                              onComment(l.new!, e.target.value);
                              setEditing(null);
                            }} />
                          <span className="faint">Leave the field to keep the comment; it goes with "Send back".</span>
                        </div>
                      ) : <p className="pre" onClick={() => canComment && setEditing(l.new)}>💬 {comment}</p>}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      )}
    </details>
  );
}

function Retry({ t, busy, act }: { t: TicketView; busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [worker, setWorker] = useState<"native" | "claude_code" | "codex">("claude_code");
  const [note, setNote] = useState("");
  if (!open) return <button className="btn ghost" disabled={busy} onClick={() => setOpen(true)}>Retry…</button>;
  return (
    <div className="stack tight retry">
      <p className="faint">This attempt stops (its pull request is closed) and the ticket starts again from the default branch. The attempt stays in the record.</p>
      <Field label="Who writes the code">
        <select value={worker} onChange={(e) => setWorker(e.target.value as typeof worker)}>
          <option value="native">The lead (its own model)</option>
          <option value="claude_code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </Field>
      <Field label="Anything to add (optional)"><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} style={{ minHeight: 60 }} /></Field>
      <div className="row">
        <button className="btn signal" disabled={busy} onClick={() => void act("retry", { worker, ...(note.trim() ? { note: note.trim() } : {}) }).then((ok) => ok && setOpen(false))}>Start again</button>
        <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Keep({ t, busy, act }: { t: TicketView; busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  if (!open) return <button className="btn signal" disabled={busy} onClick={() => setOpen(true)}>Keep…</button>;
  return (
    <div className="stack tight">
      <Field label="Repository (optional)" hint="Leave empty to create a private one; or name an empty repository you made (owner/name).">
        <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="you/new-project" pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" />
      </Field>
      <div className="row">
        <button className="btn signal" disabled={busy} onClick={() => void act("keep", repo.trim() ? { repo: repo.trim() } : {})}>Keep it as a project</button>
        <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="faint">{t.kind === "quick" ? "The quick test" : "The project"} becomes a GitHub repository and a project on this board, with the settings its lead suggested.</p>
    </div>
  );
}
