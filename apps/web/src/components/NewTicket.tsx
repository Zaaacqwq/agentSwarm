import { useEffect, useState } from "react";
import type { MissionKind, ProjectView, TicketView } from "@agentswarm/contracts";
import { api, upload } from "../api.ts";
import { useResource } from "../live.ts";
import { Field, Form } from "./ui.tsx";
import { PRIORITY_LABEL } from "./TicketCard.tsx";

const MAX_PICTURES = 6;

/** R10: the three kinds of ticket, as you would say them. */
const TYPES: readonly { kind: MissionKind; label: string; hint: string }[] = [
  { kind: "change", label: "Change a project", hint: "A fix or a small feature in an existing project. The lead does it and opens a pull request for you." },
  { kind: "newproject", label: "New project", hint: "From an idea: a plan for you to approve, built here, then kept as a GitHub repository if you like it." },
  { kind: "quick", label: "Quick test", hint: "Try something or find something out. No gates, no pull request; cleaned up after a week unless you keep it." },
];

/** A new ticket: your words, where it goes, and pictures if they help. It waits in the backlog unless you start it. */
export function NewTicket({ onCreated }: { onCreated: (t: TicketView) => void }) {
  const projects = useResource<ProjectView[]>("/projects");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [where, setWhere] = useState("");
  const [kind, setKind] = useState<MissionKind>("change");
  const [planFirst, setPlanFirst] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [researchOnly, setResearchOnly] = useState(false);
  const [priority, setPriority] = useState(0);
  const [start, setStart] = useState(false);
  const [commit, setCommit] = useState(true);
  const [pictures, setPictures] = useState<File[]>([]);
  const list = projects.data ?? [];
  const github = list.filter((p) => p.kind === "github");
  useEffect(() => {
    if (!where && github[0]) setWhere(github[0].id);
  }, [github.length, where]);
  return (
    <section className="card new-ticket" aria-label="New ticket">
      <Form submit={start ? "Create and start" : "Add to the backlog"} onSubmit={async () => {
        const space = kind === "change" ? "project" : "sandbox";
        const options = kind === "change" ? { planFirst, marketing } : kind === "quick" ? { researchOnly } : {};
        const t = await api<TicketView>("POST", "/tickets", { space, ...(space === "project" ? { projectId: where } : {}), title, description, kind, priority, commitAttachments: commit, options });
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
        <div className="segmented" role="group" aria-label="Kind of ticket">
          {TYPES.map((t) => <button key={t.kind} type="button" aria-pressed={kind === t.kind} onClick={() => setKind(t.kind)}>{t.label}</button>)}
        </div>
        <p className="faint">{TYPES.find((t) => t.kind === kind)?.hint}</p>
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="The share button is cut off on small phones" /></Field>
        <Field label="Details" hint="As you would tell a colleague. The lead asks if something is unclear.">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} style={{ minHeight: 96 }} />
        </Field>
        <div className="grid">
          {kind === "change" && (
            <Field label="Project">
              <select value={where} onChange={(e) => setWhere(e.target.value)} required>
                {github.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ticketPrefix})</option>)}
              </select>
            </Field>
          )}
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
        {kind === "change" && <label className="row"><input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} /> Show me a plan first (otherwise the lead decides: only risky changes get one)</label>}
        {kind === "change" && <label className="row"><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /> Update the marketing copy too</label>}
        {kind === "quick" && <label className="row"><input type="checkbox" checked={researchOnly} onChange={(e) => setResearchOnly(e.target.checked)} /> Only find out (a report with sources, no code)</label>}
        <label className="row"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start it (into Todo; it begins when a slot is free)</label>
        {pictures.length > 0 && <label className="row"><input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} /> Keep the pictures in the repository with the mission's documents</label>}
      </Form>
    </section>
  );
}
