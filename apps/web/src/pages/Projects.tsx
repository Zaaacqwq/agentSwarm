import { useState } from "react";
import type { GitHubStatus, ProjectProfile, ProjectView, PushView, RepoChoice } from "@agentswarm/contracts";
import { api, ago } from "../api.ts";
import { useResource } from "../live.ts";
import { Badge, Empty, Field, Form, PageHead } from "../components/ui.tsx";

export function ProjectsPage() {
  const projects = useResource<ProjectView[]>("/projects");
  const github = useResource<GitHubStatus>("/github");
  const repos = useResource<RepoChoice[]>(github.data?.configured ? "/github/repos" : null);
  const [repo, setRepo] = useState("");
  return (
    <div className="stack">
      <PageHead title="Projects" sub="A project is a GitHub repository (or a local one for experiments). agentSwarm mirrors it and protects its default branch." />
      {github.data && !github.data.configured && <div className="card">Add a GitHub token in Settings first.</div>}
      <section className="card">
        <Form submit="Add project" onSubmit={async () => {
          await api("POST", "/projects", { githubRepo: repo.trim() });
          setRepo("");
          projects.reload();
          repos.reload();
        }}>
          <div className="grid">
            <Field label="Your repositories" hint="Most recently updated first. agentSwarm's token must have access to the one you pick.">
              <select value={repos.data?.some((r) => r.fullName === repo) ? repo : ""} onChange={(e) => setRepo(e.target.value)}>
                <option value="">{repos.data ? "Choose…" : repos.error ? "Could not list repositories" : "Loading…"}</option>
                {repos.data?.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
              </select>
            </Field>
            <Field label="Or type it" hint="owner/name"><input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Zaaacqwq/agentswarm-playground" required /></Field>
          </div>
        </Form>
      </section>
      {projects.data?.length === 0 && <Empty>No projects yet.</Empty>}
      {projects.data?.map((p) => <Project key={p.id} p={p} onChange={projects.reload} />)}
    </div>
  );
}

function Project({ p, onChange }: { p: ProjectView; onChange: () => void }) {
  const pushes = useResource<PushView[]>(`/projects/${p.id}/pushes`);
  const [open, setOpen] = useState(false);
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>{p.name}</h2>
          <div className="faint"><span className="mono">{p.githubRepo}</span> · default <span className="mono">{p.defaultBranch}</span>{p.kind === "github" && <> · fetched {ago(p.lastFetchedAt)}</>}</div>
        </div>
        <div className="row">
          {p.kind === "local"
            ? <Badge status="cancelled">local only</Badge>
            : <Badge status={p.protectedAt ? "ok" : "bad"}>{p.protectedAt ? `${p.defaultBranch} protected` : `${p.defaultBranch} not protected`}</Badge>}
          {p.kind === "github" && !p.protectedAt && <button className="btn" onClick={() => api("POST", `/projects/${p.id}/protect`, {}).then(onChange).catch((e: Error) => alert(e.message))}>Protect</button>}
          {p.kind === "github" && <button className="btn ghost" onClick={() => api("POST", `/projects/${p.id}/refresh`, {}).then(onChange).catch((e: Error) => alert(e.message))}>Fetch</button>}
          <button className="btn ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Profile and files"}</button>
        </div>
      </div>
      {open && <ProjectSetup p={p} onChange={onChange} />}
      {!!pushes.data?.length && (
        <table>
          <thead><tr><th>Pushed branch</th><th>Result</th><th>When</th></tr></thead>
          <tbody>{pushes.data.slice(0, 10).map((x) => (
            <tr key={x.id}><td className="mono">{x.branch}</td><td><Badge status={x.status} />{x.reason && <div className="faint">{x.reason}</div>}</td><td className="faint">{ago(x.createdAt)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

/** What agents should know about the project, its ticket prefix, and its local files. */
/** Drops empty keys; undefined when nothing is left (the profile stays tidy). */
function prune<T extends Record<string, unknown>>(o: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
  return Object.keys(kept).length ? kept : undefined;
}

function ProjectSetup({ p, onChange }: { p: ProjectView; onChange: () => void }) {
  const [profile, setProfile] = useState<ProjectProfile>(p.profile);
  const [prefix, setPrefix] = useState(p.ticketPrefix);
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const field = (key: keyof ProjectProfile) => (e: { target: { value: string } }) => setProfile((x) => ({ ...x, [key]: e.target.value || undefined }));
  const ios = (key: "scheme" | "deviceType") => (e: { target: { value: string } }) => setProfile((x) => ({ ...x, ios: prune({ ...x.ios, [key]: e.target.value.trim() || undefined }) }));
  const [sites, setSites] = useState((p.profile.testSites ?? []).join("\n"));
  return (
    <div className="stack">
      <Form submit="Save profile" onSubmit={async () => {
        await api("PUT", `/projects/${p.id}/profile`, { profile, ...(prefix !== p.ticketPrefix ? { ticketPrefix: prefix } : {}) });
        onChange();
      }}>
        <div className="grid">
          <Field label="Platform"><input value={profile.platform ?? ""} onChange={field("platform")} placeholder="iOS (SwiftUI), Next.js, Node…" /></Field>
          <Field label="Install dependencies"><input className="mono" value={profile.setup ?? ""} onChange={field("setup")} placeholder="npm ci" /></Field>
          <Field label="Build"><input className="mono" value={profile.build ?? ""} onChange={field("build")} placeholder="xcodebuild -scheme App build" /></Field>
          <Field label="Test"><input className="mono" value={profile.test ?? ""} onChange={field("test")} placeholder="npm test" /></Field>
        </div>
        <Field label="Known failures" hint="Tests that already fail; agents leave them alone unless asked."><input value={profile.knownFailures ?? ""} onChange={field("knownFailures")} /></Field>
        <Field label="Rules" hint="What agents must know or never do here, e.g. production runs on this Mac: never deploy, only open pull requests.">
          <textarea value={profile.rules ?? ""} onChange={field("rules")} style={{ minHeight: 70 }} />
        </Field>
        <div className="grid">
          <Field label="Ticket prefix" hint="Its tickets are PREFIX-1, PREFIX-2… Changing it does not renumber old tickets.">
            <input className="mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9]{0,5}" maxLength={6} required />
          </Field>
          <Field label="Reviewer">
            <select value={profile.reviewRuntime ?? "native"} onChange={(e) => setProfile((x) => ({ ...x, reviewRuntime: e.target.value as ProjectProfile["reviewRuntime"] }))}>
              <option value="native">Native model</option>
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
        </div>
        <div className="grid">
          <Field label="iOS scheme" hint="For the simulator: what QA builds and runs.">
            <input className="mono" value={profile.ios?.scheme ?? ""} onChange={ios("scheme")} placeholder="Fridgy" />
          </Field>
          <Field label="Xcode project or workspace">
            <input className="mono" value={profile.ios?.workspace ?? profile.ios?.project ?? ""} placeholder="Fridgy.xcodeproj"
              onChange={(e) => {
                const v = e.target.value.trim();
                setProfile((x) => ({ ...x, ios: prune({ ...x.ios, project: v.endsWith(".xcodeproj") ? v : undefined, workspace: v.endsWith(".xcworkspace") ? v : undefined }) }));
              }} />
          </Field>
          <Field label="Simulator model" hint="Default: iPhone 17.">
            <input className="mono" value={profile.ios?.deviceType ?? ""} onChange={ios("deviceType")} placeholder="com.apple.CoreSimulator.SimDeviceType.iPhone-17" />
          </Field>
          <Field label="Test sites" hint="Besides localhost, where the browser may click and type. One origin per line.">
            <textarea className="mono" value={sites} onChange={(e) => {
              setSites(e.target.value);
              const list = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean);
              setProfile((x) => ({ ...x, testSites: list.length ? list : undefined }));
            }} placeholder="https://staging.example.com" style={{ minHeight: 40 }} />
          </Field>
        </div>
        <label className="row"><input type="checkbox" checked={profile.autoApproveBugs ?? false} onChange={(e) => setProfile((x) => ({ ...x, autoApproveBugs: e.target.checked }))} /> Bug fixes go ahead without asking me to approve the plan (I still merge the pull request)</label>
      </Form>
      <div className="stack">
        <h3>Local files</h3>
        <p className="faint">Files this project needs that are not in git (Local.xcconfig, Secrets.plist, .env). They are encrypted here, written into every worktree, and refused in any push. Agents can read them: prefer development keys.</p>
        {p.files.length > 0 && (
          <table>
            <tbody>{p.files.map((f) => (
              <tr key={f.path}><td className="mono">{f.path}</td><td className="faint">{ago(f.updatedAt)}</td>
                <td><button className="btn ghost" onClick={() => api("DELETE", `/projects/${p.id}/files?path=${encodeURIComponent(f.path)}`).then(onChange).catch((e: Error) => alert(e.message))}>Remove</button></td></tr>
            ))}</tbody>
          </table>
        )}
        <Form submit="Save file" onSubmit={async () => {
          await api("PUT", `/projects/${p.id}/files`, { path: path.trim(), content });
          setPath("");
          setContent("");
          onChange();
        }}>
          <div className="grid">
            <Field label="Path in the repository"><input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Local.xcconfig" required /></Field>
            <Field label="Or pick a file"><input type="file" onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (!path) setPath(file.name);
              void file.text().then(setContent);
            }} /></Field>
          </div>
          <Field label="Content"><textarea className="mono" value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 90 }} required /></Field>
        </Form>
      </div>
    </div>
  );
}
