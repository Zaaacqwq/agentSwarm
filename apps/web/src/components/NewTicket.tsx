import { useEffect, useState } from "react";
import type { MissionKind, ProjectView, TicketView } from "@agentswarm/contracts";
import { api, upload } from "../api.ts";
import { useResource } from "../live.ts";
import { Field, Form } from "./ui.tsx";
import { KIND_LABEL, PRIORITY_LABEL } from "./TicketCard.tsx";

const MAX_PICTURES = 6;

/** Where a ticket goes: a project, the sandbox (experiments) or ideas (research without a repository). */
function kindsFor(where: string, projects: readonly ProjectView[]): MissionKind[] {
  if (where === "sandbox") return ["experiment"];
  if (where === "ideas") return ["research"];
  return projects.find((p) => p.id === where)?.kind === "local" ? ["research"] : ["feature", "bug", "research"];
}

/** A new ticket: your words, where it goes, and pictures if they help. It waits in the backlog unless you start it. */
export function NewTicket({ onCreated }: { onCreated: (t: TicketView) => void }) {
  const projects = useResource<ProjectView[]>("/projects");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [where, setWhere] = useState("");
  const [kind, setKind] = useState<MissionKind>("feature");
  const [priority, setPriority] = useState(0);
  const [start, setStart] = useState(false);
  const [commit, setCommit] = useState(true);
  const [pictures, setPictures] = useState<File[]>([]);
  const list = projects.data ?? [];
  useEffect(() => {
    if (!where && list[0]) setWhere(list.find((p) => p.kind === "github")?.id ?? list[0].id);
  }, [list, where]);
  const kinds = kindsFor(where, list);
  useEffect(() => {
    if (!kinds.includes(kind)) setKind(kinds[0]!);
  }, [kinds.join(), kind]);
  return (
    <section className="card new-ticket" aria-label="New ticket">
      <Form submit={start ? "Create and start" : "Add to the backlog"} onSubmit={async () => {
        const space = where === "sandbox" || where === "ideas" ? where : "project";
        const t = await api<TicketView>("POST", "/tickets", { space, ...(space === "project" ? { projectId: where } : {}), title, description, kind, priority, commitAttachments: commit });
        // Pictures first, then it may start: the lead sees them in its first message.
        const failed: string[] = [];
        for (const file of pictures) {
          await upload(`/tickets/${t.key}/attachments`, file, file.name).catch((e: Error) => void failed.push(`${file.name}: ${e.message}`));
        }
        // The ticket exists either way: never make you create it twice. With a picture missing, it waits for you.
        if (failed.length) alert(`${t.key} was created, but these pictures were not added:\n${failed.join("\n")}\n\nAdd them on the ticket${start ? ", then move it to Todo" : ""}.`);
        else if (start) await api("POST", `/tickets/${t.key}/move`, { status: "todo" }).catch((e: Error) => alert(`${t.key} was created but did not start: ${e.message}`));
        onCreated(t);
      }}>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="The share button is cut off on small phones" /></Field>
        <Field label="Details" hint="As you would tell a colleague. The lead asks if something is unclear.">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} style={{ minHeight: 96 }} />
        </Field>
        <div className="grid">
          <Field label="Where">
            <select value={where} onChange={(e) => setWhere(e.target.value)} required>
              {list.filter((p) => p.kind === "github").map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ticketPrefix})</option>)}
              <option value="sandbox">Sandbox: an experiment in a fresh local repository</option>
              <option value="ideas">Ideas: research, no repository yet</option>
            </select>
          </Field>
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value as MissionKind)}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}{k === "bug" ? " (fast track)" : ""}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4, 0].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Pictures" hint={`Up to ${MAX_PICTURES}, e.g. a screenshot of the bug. JPEG, PNG or HEIC.`}>
          <input type="file" accept="image/jpeg,image/png,image/heic,image/heif" multiple onChange={(e) => setPictures([...(e.target.files ?? [])].slice(0, MAX_PICTURES))} />
        </Field>
        {pictures.length > 0 && (
          <ul className="picture-strip" aria-label="Chosen pictures">
            {pictures.map((f) => <li key={f.name + f.size}><img src={URL.createObjectURL(f)} alt={f.name} /></li>)}
          </ul>
        )}
        <label className="row"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start it (into Todo; it begins when a slot is free)</label>
        {pictures.length > 0 && <label className="row"><input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} /> Keep the pictures in the repository with the mission's documents</label>}
      </Form>
    </section>
  );
}
