import { useEffect, useState } from "react";
import type { CliStatusView, CliTestResult, CodexWorkstationView, DiscordStatus, EndpointKind, EndpointView, GitHubStatus, DesktopView, MachineLoadView, MachineSettings, ModelSettings, ModelView, TicketSettings } from "@agentswarm/contracts";
import { api, ago, until, when } from "../api.ts";
import { useLive, useResource } from "../live.ts";
import { Badge, Field, Form, Meter, PageHead } from "../components/ui.tsx";

export function SettingsPage() {
  const endpoints = useResource<EndpointView[]>("/endpoints");
  const github = useResource<GitHubStatus>("/github");
  const [name, setName] = useState("OpenRouter");
  const [kind, setKind] = useState<EndpointKind>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  return (
    <div className="stack">
      <PageHead title="Settings" sub="Keys are encrypted on this Mac and never shown again." />
      <div className="split">
        <section className="card stack" aria-labelledby="ep">
          <h2 id="ep">Model endpoints</h2>
          <table>
            <tbody>{endpoints.data?.map((ep) => (
              <tr key={ep.id}>
                <td><b>{ep.name}</b><div className="faint mono">{ep.baseUrl}</div></td>
                <td><Badge status={ep.hasKey ? "ok" : "cancelled"}>{ep.hasKey ? "key stored" : "no key"}</Badge></td>
                <td><button className="btn ghost" onClick={() => api("DELETE", `/endpoints/${ep.id}`).then(endpoints.reload).catch((e: Error) => alert(e.message))}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table>
          <Form submit="Add endpoint" onSubmit={async () => {
            await api("POST", "/endpoints", { name, kind, ...(kind === "openai-compatible" ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) });
            setApiKey("");
            endpoints.reload();
          }}>
            <div className="grid">
              <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
              <Field label="Kind">
                <select value={kind} onChange={(e) => setKind(e.target.value as EndpointKind)}>
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai-compatible">OpenAI-compatible (local)</option>
                </select>
              </Field>
            </div>
            {kind === "openai-compatible" && <Field label="Base URL"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" required /></Field>}
            <Field label="API key"><input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={kind === "openrouter"} /></Field>
          </Form>
        </section>
        <section className="card stack" aria-labelledby="gh">
          <h2 id="gh">GitHub</h2>
          {github.data?.configured
            ? <p><Badge status={github.data.error ? "bad" : "ok"}>{github.data.login}</Badge><br /><span className="faint">{github.data.error ?? (github.data.expiresAt ? `Expires ${when(github.data.expiresAt)}` : "No expiry")}</span></p>
            : <p className="muted">No token yet.</p>}
          <Form submit={github.data?.configured ? "Replace token" : "Save token"} onSubmit={async () => {
            await api("PUT", "/github", { token });
            setToken("");
            github.reload();
          }}>
            <Field label="Fine-grained token" hint="Only your agentSwarm repositories: Contents, Pull requests and Administration (read and write).">
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
            </Field>
          </Form>
        </section>
      </div>
      <Backup endpoints={endpoints.data ?? []} />
      <Board />
      <Discord />
      <CliWorkers />
      <Machine />
    </div>
  );
}

/** The model a run switches to when its own refuses the content (a provider's moderation) or keeps failing. */
function Backup({ endpoints }: { endpoints: EndpointView[] }) {
  const settings = useResource<ModelSettings>("/models/settings");
  const [endpointId, setEndpointId] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const saved = settings.data?.backup ?? null;
  const ep = endpointId || saved?.endpointId || endpoints[0]?.id || "";
  useEffect(() => {
    if (ep) api<ModelView[]>("GET", `/endpoints/${ep}/models`).then(setModels).catch(() => setModels([]));
  }, [ep]);
  if (!settings.data) return null;
  const save = async (backup: ModelSettings["backup"]) => {
    const v = await api<ModelSettings>("PUT", "/models/settings", { backup });
    settings.set(() => v);
    setModelId(null);
  };
  return (
    <section className="card stack" aria-labelledby="backup-head">
      <h2 id="backup-head">Backup model</h2>
      <p className="faint">
        {saved ? <>Now: <span className="mono">{saved.modelId}</span>. </> : "None yet: a run whose model refuses fails. "}
        When a provider refuses the content (its moderation), a run switches to this model at once; when the model keeps failing, after two retries.
        Pick one from another provider.
      </p>
      <Form submit="Save" onSubmit={async () => save({ endpointId: ep, modelId: (modelId ?? saved?.modelId ?? "").trim() })}>
        <div className="grid">
          <Field label="Endpoint">
            <select value={ep} onChange={(e) => setEndpointId(e.target.value)} required>
              {endpoints.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="Backup model" hint={models.length ? `${models.length} models on this endpoint` : undefined}>
            <input list="backup-models" className="mono" value={modelId ?? saved?.modelId ?? ""} onChange={(e) => setModelId(e.target.value)} placeholder="anthropic/claude-haiku-5-5" required />
            <datalist id="backup-models">{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
          </Field>
        </div>
        {saved && <button type="button" className="btn ghost small" onClick={() => void save(null)}>No backup model</button>}
      </Form>
    </section>
  );
}

/** The board (R7): how many tickets are worked on at once; the rest wait in Todo by priority. */
function Board() {
  const settings = useResource<TicketSettings>("/tickets/settings");
  const [value, setValue] = useState<string | null>(null);
  if (!settings.data) return null;
  return (
    <section className="card stack" aria-labelledby="board-head">
      <h2 id="board-head">Tickets</h2>
      <Form submit="Save" onSubmit={async () => {
        const v = await api<TicketSettings>("PUT", "/tickets/settings", { maxActive: Number(value ?? settings.data!.maxActive) });
        settings.set(() => v);
        setValue(null);
      }}>
        <Field label="Tickets worked on at once" hint="Each has its own lead and agents. Todo tickets beyond this wait, the most urgent first.">
          <input type="number" min={1} max={8} value={value ?? String(settings.data.maxActive)} onChange={(e) => setValue(e.target.value)} required />
        </Field>
      </Form>
    </section>
  );
}


/** Settings about this Mac that agents must respect. */
function Machine() {
  const m = useResource<MachineSettings>("/machine");
  const [ports, setPorts] = useState<string | null>(null);
  if (!m.data) return null;
  const value = ports ?? m.data.denyPorts.join(", ");
  return (
    <section className="card stack" aria-labelledby="mc">
      <h2 id="mc">This Mac</h2>
      <MachineLoad />
      <DesktopHelper />
      <Form submit="Save" onSubmit={async () => {
        const list = value.split(/[\s,]+/).filter(Boolean).map(Number);
        const v = await api<MachineSettings>("PUT", "/machine", { denyPorts: list });
        m.set(() => v);
        setPorts(null);
      }}>
        <Field label="Local ports agents may not connect to" hint="Services running on this Mac that agents must never touch: production servers, databases. swarmd's own port is always blocked.">
          <input className="mono" value={value} onChange={(e) => setPorts(e.target.value)} placeholder="3000, 5432" />
        </Field>
      </Form>
    </section>
  );
}

/** R9: the helper that lets an agent test a Mac app on this desktop, in sessions you approve. */
function DesktopHelper() {
  const d = useResource<DesktopView>("/desktop");
  useLive((m) => void (m.kind === "desktop" && d.set(() => m.desktop)));
  const h = d.data?.helper;
  if (!h) return null;
  const missing = [!h.screenRecording && "Screen & System Audio Recording", !h.accessibility && "Accessibility"].filter(Boolean);
  const state = !h.running ? "not installed" : missing.length ? `needs ${missing.join(" and ")}` : h.stoppedByUser ? "stopped from the menu bar: your next approval starts it again" : h.watching ? "ready" : "ready, but cannot tell when you use the Mac (restart it)";
  return (
    <div className="stack tight">
      <p><b>Desktop</b> <Badge status={h.running && !missing.length ? "ok" : "cancelled"}>{state}</Badge></p>
      {(!h.running || missing.length > 0) && (
        <p className="faint">
          {!h.running ? <>Run <code>zsh scripts/setup-desktop.sh</code> in the agentSwarm folder (no sudo). </> : null}
          {missing.length ? <>Then grant agentSwarm Desktop {missing.join(" and ")} in System Settings → Privacy &amp; Security, and run the script again.</> : null}
        </p>
      )}
    </div>
  );
}

const PRESSURE: Record<number, string> = { 1: "normal", 2: "warning: new simulator runs wait", 4: "critical: new simulator runs wait" };

/** Simulators and browsers in use (R6): they hold heavy slots, and wait when memory is tight. */
function MachineLoad() {
  const load = useResource<MachineLoadView>("/machine/load");
  useLive((m) => {
    if (m.kind === "run") load.reload();
  });
  const l = load.data;
  if (!l) return null;
  return (
    <p className="row faint" aria-live="polite">
      <Badge status={l.heavyRunning ? "running" : "idle"}>{`${l.heavyRunning} of ${l.heavySlots}`}</Badge>
      simulators and browsers in use{l.heavyQueued ? `, ${l.heavyQueued} waiting` : ""} · memory {PRESSURE[l.memoryPressure] ?? `level ${l.memoryPressure}`}
    </p>
  );
}

/** Claude Code and Codex as sub-agents on your subscriptions (R4). */
function CliWorkers() {
  const status = useResource<CliStatusView>("/cli");
  useLive((m) => {
    if (m.kind === "cli") status.set(() => m.cli);
  });
  const [token, setToken] = useState("");
  const [tests, setTests] = useState<Record<string, string>>({});
  const s = status.data;
  if (!s) return status.error ? <p className="error">{status.error}</p> : null;
  const put = (body: Record<string, unknown>) => api<CliStatusView>("PUT", "/cli", body).then((v) => void status.set(() => v));
  const test = (runtime: "claude_code" | "codex") => {
    setTests((t) => ({ ...t, [runtime]: "Testing on a free workstation…" }));
    api<CliTestResult>("POST", `/cli/${runtime}/test`, {})
      .then((r) => setTests((t) => ({ ...t, [runtime]: `${r.ok ? "OK" : "Failed"}${r.workstationId ? ` on ${r.workstationId}` : ""}: ${r.detail}` })))
      .catch((e: Error) => setTests((t) => ({ ...t, [runtime]: e.message })));
  };
  const version = (v: string | null, pinned: string) => (v ? (v === pinned ? `version ${v}` : `version ${v} (tested with ${pinned})`) : "not installed: run sudo zsh scripts/setup.sh --update-exec");
  const q = s.claude.quota;
  return (
    <section className="card stack" aria-labelledby="cli">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="cli">CLI workers</h2>
        <button className="btn ghost" onClick={() => api<CliStatusView>("POST", "/cli/refresh", {}).then((v) => status.set(() => v))}>Check again</button>
      </div>
      <p className="muted">Leads can give development work to Claude Code or Codex. They run in the same workstation sandboxes and use your subscriptions, not the mission budget; at most {s.maxConcurrent} of each run at once.</p>
      <div className="split">
        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Claude Code</h3>
            <Badge status={s.claude.available ? "ok" : "cancelled"}>{s.claude.available ? "available" : "unavailable"}</Badge>
          </div>
          <span className="faint">{version(s.claude.version, s.claude.pinned)}{s.claude.reason ? ` · ${s.claude.reason}` : ""}</span>
          <label className="row"><input type="checkbox" checked={s.claude.enabled} onChange={(e) => void put({ claudeEnabled: e.target.checked })} /> Leads may use Claude Code</label>
          {q && (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <Meter label="5-hour window" value={q.fiveHour} limit={s.fiveHourLimit} note={q.fiveHourResetsAt ? `resets ${until(q.fiveHourResetsAt)}` : undefined} />
              <Meter label="7-day window" value={q.sevenDay} limit={s.sevenDayLimit} note={q.sevenDayResetsAt ? `resets ${until(q.sevenDayResetsAt)}` : undefined} />
              <span className="faint">Read {ago(q.at)}. New Claude Code sub-agents stop past the marks ({Math.round(s.fiveHourLimit * 100)}% and {Math.round(s.sevenDayLimit * 100)}%).</span>
            </div>
          )}
          <Form submit={s.claude.hasToken ? "Replace Claude token" : "Save Claude token"} onSubmit={async () => {
            await put({ claudeToken: token.trim() });
            setToken("");
          }}>
            <Field label="Long-lived token" hint="Run claude setup-token in your own terminal and paste the token. It is encrypted here and handed to Claude Code through a file descriptor, never in its environment.">
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.claude.hasToken ? "stored" : "sk-ant-oat01-…"} required />
            </Field>
          </Form>
          <div className="row">
            <button className="btn ghost" disabled={!s.claude.hasToken} onClick={() => test("claude_code")}>Test</button>
            {s.claude.hasToken && <button className="btn ghost" onClick={() => void put({ clearClaudeToken: true })}>Remove token</button>}
            {tests.claude_code && <span className="faint" role="status">{tests.claude_code}</span>}
          </div>
        </div>
        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Codex</h3>
            <Badge status={s.codex.available ? "ok" : "cancelled"}>{s.codex.available ? "available" : "unavailable"}</Badge>
          </div>
          <span className="faint">{version(s.codex.version, s.codex.pinned)}{s.codex.reason ? ` · ${s.codex.reason}` : ""}</span>
          <label className="row"><input type="checkbox" checked={s.codex.enabled} onChange={(e) => void put({ codexEnabled: e.target.checked })} /> Leads may use Codex</label>
          <p className="faint">Each workstation signs in to your ChatGPT account on its own, so sign-ins never fight over one refresh token. Codex sub-agents run only where it is signed in.</p>
          <div className="cli-ws">{s.codex.workstations.map((w) => <CodexWorkstation key={w.workstationId} w={w} onChange={(v) => status.set(() => v)} />)}</div>
          <div className="row">
            <button className="btn ghost" disabled={!s.codex.workstations.some((w) => w.signedInAt)} onClick={() => test("codex")}>Test</button>
            {tests.codex && <span className="faint" role="status">{tests.codex}</span>}
          </div>
        </div>
      </div>
      <CliLimits s={s} save={put} />
    </section>
  );
}

function CliLimits({ s, save }: { s: CliStatusView; save: (body: Record<string, unknown>) => Promise<void> }) {
  const [max, setMax] = useState(s.maxConcurrent);
  const [five, setFive] = useState(Math.round(s.fiveHourLimit * 100));
  const [seven, setSeven] = useState(Math.round(s.sevenDayLimit * 100));
  return (
    <Form submit="Save limits" onSubmit={() => save({ maxConcurrent: max, fiveHourLimit: five / 100, sevenDayLimit: seven / 100 })}>
      <div className="grid">
        <Field label="At once, per CLI"><input type="number" min={1} max={8} value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field>
        <Field label="Stop at 5-hour use (%)"><input type="number" min={10} max={100} value={five} onChange={(e) => setFive(Number(e.target.value))} /></Field>
        <Field label="Stop at 7-day use (%)"><input type="number" min={10} max={100} value={seven} onChange={(e) => setSeven(Number(e.target.value))} /></Field>
      </div>
    </Form>
  );
}

function CodexWorkstation({ w, onChange }: { w: CodexWorkstationView; onChange: (v: CliStatusView) => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = (path: string) => {
    setError(null);
    api<CliStatusView>("POST", `/cli/codex/${w.workstationId}/${path}`, {}).then(onChange).catch((e: Error) => setError(e.message));
  };
  const waiting = w.login?.state === "waiting";
  return (
    <>
      <b className="mono">{w.workstationId}</b>
      <div className="stack" style={{ gap: "var(--space-1)" }}>
        {w.signedInAt ? <Badge status="ok">signed in</Badge> : <span className="faint">not signed in</span>}
        {waiting && (
          <>
            <span className="faint">Open <a href={w.login!.url ?? "https://auth.openai.com/codex/device"} target="_blank" rel="noreferrer">{w.login!.url ?? "the sign-in page"}</a> and enter:</span>
            {w.login!.code ? <span className="device-code" aria-label="One-time code">{w.login!.code}</span> : <span className="faint">Waiting for the code…</span>}
          </>
        )}
        {w.login?.state === "failed" && <span className="error">{w.login.error}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
      <div className="row">
        {waiting
          ? <button className="btn ghost" onClick={() => act("login/cancel")}>Cancel</button>
          : w.signedInAt
            ? <button className="btn ghost" onClick={() => act("logout")}>Sign out</button>
            : <button className="btn" onClick={() => act("login")}>Sign in</button>}
      </div>
    </>
  );
}

function Discord() {
  const status = useResource<DiscordStatus>("/discord");
  const [token, setToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [tested, setTested] = useState<string | null>(null);
  const s = status.data;
  return (
    <section className="card stack" aria-labelledby="dc">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="dc">Discord</h2>
        {s?.configured && <Badge status={s.connected ? "ok" : "bad"}>{s.connected ? `${s.botTag} in #${s.channelName}` : "not connected"}</Badge>}
      </div>
      <p className="muted">Each mission gets a thread in one channel. Only your Discord account is obeyed; everyone else is ignored.</p>
      {s?.error && <p className="error" role="alert">{s.error}</p>}
      <Form submit={s?.configured ? "Save and reconnect" : "Connect"} onSubmit={async () => {
        await api<DiscordStatus>("PUT", "/discord", { ...(token ? { token } : {}), channelId: channelId || s?.channelId, ownerId: ownerId || s?.ownerId });
        setToken("");
        status.reload();
      }}>
        <div className="grid">
          <Field label="Bot token" hint={s?.configured ? "Leave empty to keep the stored token." : "From the Discord developer portal (Bot → Reset Token)."}>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required={!s?.configured} />
          </Field>
          <Field label="Channel ID" hint="Right-click the channel → Copy Channel ID (developer mode).">
            <input inputMode="numeric" pattern="[0-9]{17,20}" value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder={s?.channelId ?? ""} required={!s?.channelId} />
          </Field>
          <Field label="Your user ID" hint="Right-click your name → Copy User ID.">
            <input inputMode="numeric" pattern="[0-9]{17,20}" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder={s?.ownerId ?? ""} required={!s?.ownerId} />
          </Field>
        </div>
      </Form>
      {s?.connected && (
        <div className="row">
          <button className="btn ghost" onClick={() => api("POST", "/discord/test", {}).then(() => setTested("Sent a test message to the channel.")).catch((e: Error) => setTested(e.message))}>Send a test message</button>
          {tested && <span className="faint">{tested}</span>}
        </div>
      )}
    </section>
  );
}
