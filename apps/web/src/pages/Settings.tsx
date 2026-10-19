import { useState } from "react";
import type { DiscordStatus, EndpointKind, EndpointView, GitHubStatus } from "@agentswarm/contracts";
import { api, when } from "../api.ts";
import { useResource } from "../live.ts";
import { Badge, Field, Form, PageHead } from "../components/ui.tsx";

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
      <Discord />
    </div>
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
