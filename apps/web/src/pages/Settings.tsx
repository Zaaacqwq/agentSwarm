import { useState } from "react";
import type { EndpointKind, EndpointView, GitHubStatus } from "@hive/contracts";
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
            <Field label="Fine-grained token" hint="Only your Hive repositories: Contents, Pull requests and Administration (read and write).">
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
            </Field>
          </Form>
        </section>
      </div>
    </div>
  );
}
