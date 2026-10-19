import { useEffect, useState } from "react";
import type { InboxFileView, OutputFileView, TicketView } from "@agentswarm/contracts";
import { api, upload } from "../api.ts";
import { useResource } from "../live.ts";

/** R10: what a ticket may bring: an assignment, data, documents. */
export const MAX_FILES = 10;
export const FILE_ACCEPT = ".pdf,.zip,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.ipynb,.py,.js,.ts,.swift,.java,.c,.h,.cpp,.rs,.go,.html,.css,.sql,.xml,.yaml,.yml,.tex,.r,.m";

export const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Files on a ticket: added (uploaded, or from the inbox on the Mac) and removed before it starts; downloadable always. */
export function TicketFiles({ t }: { t: TicketView }) {
  const fixed = Boolean(t.missionId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (fixed && !t.files.length) return null;
  const add = async (files: File[]) => {
    setBusy(true);
    const failed: string[] = [];
    for (const f of files.slice(0, MAX_FILES - t.files.length)) {
      await upload(`/tickets/${t.key}/files`, f, f.name, true).catch((e: Error) => void failed.push(`${f.name}: ${e.message}`));
    }
    setError(failed.length ? failed.join("\n") : null);
    setBusy(false);
  };
  return (
    <div className="stack tight">
      <h3 className="mini">Files</h3>
      {t.files.length > 0 && (
        <ul className="file-list">
          {t.files.map((f) => (
            <li key={f.id}>
              <a href={f.url} download={f.name} className="mono">{f.name}</a> <span className="faint">{size(f.bytes)}</span>
              {!fixed && <button className="btn ghost small" aria-label={`Remove ${f.name}`} onClick={() => api("DELETE", `/tickets/${t.key}/files/${f.id}`).catch((e: Error) => setError(e.message))}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!fixed && t.files.length < MAX_FILES && (
        <div className="row">
          <label className={`btn ghost small file-pick${busy ? " disabled" : ""}`}>
            Add files
            <input type="file" multiple accept={FILE_ACCEPT} disabled={busy} onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void add(files);
            }} />
          </label>
          <InboxPicker t={t} onError={setError} />
        </div>
      )}
      {error && <p className="error pre" role="alert">{error}</p>}
      <p className="faint">{fixed ? "Its lead got them under inputs/ (never committed)." : "PDF, zip, Office or text files, up to 25 MB each. The lead finds them under inputs/; they are never committed."}</p>
    </div>
  );
}

/** The ~/agentSwarm-inbox folder on the Mac: files you put there from a download, attached without uploading. */
function InboxPicker({ t, onError }: { t: TicketView; onError: (e: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const inbox = useResource<InboxFileView[]>(open ? "/inbox" : null);
  const taken = new Set(t.files.map((f) => f.name));
  if (!open) return <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>From the inbox…</button>;
  return (
    <div className="inbox-pick card" role="dialog" aria-label="Files in the inbox">
      <div className="row spread">
        <b>~/agentSwarm-inbox</b>
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>Close</button>
      </div>
      {inbox.data && inbox.data.length === 0 && <p className="faint">Empty. Put a file in the agentSwarm-inbox folder in your home folder on the Mac, then look again.</p>}
      <ul className="file-list">
        {(inbox.data ?? []).map((f) => (
          <li key={f.name}>
            <span className="mono">{f.name}</span> <span className="faint">{size(f.bytes)}</span>
            <button type="button" className="btn small" disabled={taken.has(f.name)} onClick={() => api("POST", `/tickets/${t.key}/files/from-inbox`, { name: f.name }).then(() => onError(null), (e: Error) => onError(e.message))}>
              {taken.has(f.name) ? "Added" : "Add"}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn ghost small" onClick={() => inbox.reload()}>Look again</button>
    </div>
  );
}

/** What the work handed back: outputs/ and the results document, each to download, or all as one zip. */
export function Outputs({ t }: { t: TicketView }) {
  const outputs = useResource<OutputFileView[]>(t.missionId ? `/tickets/${t.key}/outputs` : null);
  // A new push or a new stage may bring new files.
  useEffect(() => {
    outputs.reload();
  }, [t.stage, t.status]);
  const files = outputs.data ?? [];
  if (!files.length) return null;
  return (
    <section className="card stack tight outputs" aria-labelledby="outputs-head">
      <div className="row spread">
        <h2 id="outputs-head">What it handed back</h2>
        <a className="btn small" href={`/api/tickets/${t.key}/outputs.zip`} download={`${t.key}-results.zip`}>Download all (zip)</a>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.path}>
            <a className="mono" href={`/api/tickets/${t.key}/outputs/file?path=${encodeURIComponent(f.path)}`} download={f.path.split("/").pop()}>{f.path}</a> <span className="faint">{size(f.bytes)}</span>
          </li>
        ))}
      </ul>
      {t.kind === "quick" && <p className="faint">For an assignment: read it, check it, and hand it in yourself. agentSwarm never submits anything.</p>}
    </section>
  );
}

/** Tickets this one waits for: it starts only once they are done. */
export function WaitsFor({ self, value, onChange }: { self?: string; value: readonly string[]; onChange: (keys: string[]) => void }) {
  const tickets = useResource<TicketView[]>("/tickets");
  const choices = (tickets.data ?? []).filter((x) => x.key !== self && !value.includes(x.key) && x.status !== "done" && x.status !== "canceled");
  return (
    <div className="waits-for">
      {value.map((k) => (
        <span key={k} className="chip mono">
          {k}
          <button type="button" aria-label={`Stop waiting for ${k}`} onClick={() => onChange(value.filter((v) => v !== k))}>×</button>
        </span>
      ))}
      {value.length < 10 && (
        <select aria-label="Wait for a ticket" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{value.length ? "And…" : "Nothing"}</option>
          {choices.map((x) => <option key={x.key} value={x.key}>{x.key} {x.title.slice(0, 60)}</option>)}
        </select>
      )}
    </div>
  );
}
