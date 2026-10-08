import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, Plus, Trash2 } from "lucide-react";
import type { Endpoint, EndpointKind, SessionInfo } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, Select, TextInput } from "../../components/ui/Field.tsx";
import { tokens, usd } from "../../lib/format.ts";

export function SettingsPage() {
  const client = useQueryClient();
  const endpoints = useQuery({ queryKey: qk.endpoints, queryFn: api.endpoints });
  const usage = useQuery({ queryKey: qk.usage, queryFn: api.usage });
  const session = client.getQueryData<SessionInfo>(qk.session);
  const [adding, setAdding] = useState(false);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      // Keep the session query (App observes it); drop everything else.
      client.setQueryData(qk.session, { setupRequired: false, user: null });
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] });
    },
  });

  return (
    <div className="mx-auto h-full max-w-3xl space-y-4 overflow-y-auto pb-6">
      <section className="rounded-card border border-line bg-surface/80 p-5 backdrop-blur">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight">Model endpoints</h2>
            <p className="text-sm text-muted">Keys are encrypted at rest in hived and are never sent back to the browser.</p>
          </div>
          {!adding ? <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add</Button> : null}
        </div>
        {adding ? <EndpointForm onDone={() => setAdding(false)} /> : null}
        <ul className="space-y-2">
          {(endpoints.data ?? []).map((ep) => <EndpointRow key={ep.id} endpoint={ep} />)}
          {endpoints.isSuccess && endpoints.data.length === 0 && !adding ? (
            <li className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No endpoints yet. Add OpenRouter to get started.</li>
          ) : null}
        </ul>
      </section>

      <section className="grid gap-4 sm:grid-cols-[1.4fr_1fr]">
        <div className="rounded-card border border-line bg-surface/80 p-5 backdrop-blur">
          <h2 className="mb-3 text-lg font-extrabold tracking-tight">Spend so far</h2>
          <p className="font-mono text-4xl font-semibold text-honey">{usd(usage.data?.costUsd ?? 0)}</p>
          <p className="mt-1 text-sm text-muted">
            {tokens(usage.data?.inputTokens ?? 0)} in · {tokens(usage.data?.outputTokens ?? 0)} out · {usage.data?.runs ?? 0} metered runs
          </p>
        </div>
        <div className="rounded-card border border-line bg-surface/80 p-5 backdrop-blur">
          <h2 className="mb-3 text-lg font-extrabold tracking-tight">Account</h2>
          <p className="text-sm text-muted">Signed in as <span className="font-semibold text-ink">{session?.user?.username}</span> ({session?.user?.role})</p>
          <Button className="mt-4" size="sm" variant="ghost" icon={<LogOut size={14} />} onClick={() => logout.mutate()}>Sign out</Button>
        </div>
      </section>
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const client = useQueryClient();
  const [rotating, setRotating] = useState(false);
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: qk.endpoints });
  const rotate = useMutation({ mutationFn: () => api.updateEndpoint(endpoint.id, { apiKey: key }), onSuccess: () => { setRotating(false); setKey(""); refresh(); } });
  const remove = useMutation({ mutationFn: () => api.deleteEndpoint(endpoint.id), onSuccess: refresh });

  return (
    <li className="rounded-2xl border border-line bg-sunken/70 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-pill bg-raised px-2 py-0.5 font-mono text-[0.7rem] text-muted">{endpoint.kind}</span>
        <span className="font-semibold">{endpoint.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">{endpoint.baseUrl}</span>
        <Button size="sm" variant="quiet" icon={<KeyRound size={13} />} onClick={() => setRotating((r) => !r)}>Rotate key</Button>
        {confirm ? (
          <>
            <Button size="sm" variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>Confirm</Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirm(false)}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" variant="quiet" icon={<Trash2 size={13} />} onClick={() => setConfirm(true)} aria-label={`Delete ${endpoint.name}`} />
        )}
      </div>
      {confirm ? <p className="mt-2 text-xs text-warn">Agents using this endpoint will fail until you pick another one.</p> : null}
      {rotating ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); rotate.mutate(); }}>
          <TextInput type="password" autoComplete="off" placeholder="New API key" value={key} onChange={(e) => setKey(e.target.value)} required minLength={8} />
          <Button type="submit" size="md" variant="primary" disabled={rotate.isPending}>Save</Button>
        </form>
      ) : null}
      <ErrorNote error={rotate.error ?? remove.error} />
    </li>
  );
}

function EndpointForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const [kind, setKind] = useState<EndpointKind>("openrouter");
  const [name, setName] = useState("OpenRouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const create = useMutation({
    mutationFn: () => api.createEndpoint({ name, kind, apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.endpoints });
      onDone();
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={onSubmit} className="mb-4 space-y-4 rounded-2xl border border-honey/30 bg-sunken/70 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => { const k = e.target.value as EndpointKind; setKind(k); setName(k === "openrouter" ? "OpenRouter" : "Local model"); }}>
            <option value="openrouter">OpenRouter</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </Select>
        </Field>
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} /></Field>
      </div>
      <Field label="Base URL" hint={kind === "openrouter" ? "Leave empty for https://openrouter.ai/api/v1." : "For example http://127.0.0.1:8080/v1"}>
        <TextInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required={kind !== "openrouter"} className="font-mono" placeholder={kind === "openrouter" ? "https://openrouter.ai/api/v1" : "http://"} />
      </Field>
      <Field label="API key" hint="Tip: cap the key's credit limit in OpenRouter and restrict it to providers that do not retain data.">
        <TextInput type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required minLength={8} className="font-mono" />
      </Field>
      <ErrorNote error={create.error} />
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save endpoint"}</Button>
      </div>
    </form>
  );
}
