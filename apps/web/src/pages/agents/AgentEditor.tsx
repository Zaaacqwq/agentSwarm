import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessagesSquare, Trash2 } from "lucide-react";
import type { Agent, CreateAgent, ThinkingLevel, ToolGrant } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { ErrorNote, Field, Select, TextArea, TextInput } from "../../components/ui/Field.tsx";
import { GrantPicker } from "./GrantPicker.tsx";

const THINKING: ThinkingLevel[] = ["off", "low", "medium", "high"];
const BASELINE_GRANTS: ToolGrant[] = [{ toolpackId: "core.communication", toolName: "*" }];

export function AgentEditor({ agent }: { agent: Agent | undefined }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const endpoints = useQuery({ queryKey: qk.endpoints, queryFn: api.endpoints });
  const workstations = useQuery({ queryKey: qk.workstations, queryFn: api.workstations });
  const [workstationId, setWorkstationId] = useState<string>(agent?.workstationId ?? "");
  const [form, setForm] = useState<CreateAgent>(() => ({
    name: agent?.name ?? "",
    role: agent?.role ?? "",
    instructions: agent?.instructions ?? "",
    endpointId: agent?.endpointId ?? "",
    modelId: agent?.modelId ?? "",
    thinkingLevel: agent?.thinkingLevel ?? "medium",
    grants: agent?.grants ?? BASELINE_GRANTS,
  }));
  const endpointId = form.endpointId || endpoints.data?.[0]?.id || "";
  const set = <K extends keyof CreateAgent>(key: K, value: CreateAgent[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const payload = { ...form, endpointId };
      const saved = agent ? await api.updateAgent(agent.id, payload) : await api.createAgent(payload);
      if ((saved.workstationId ?? "") !== workstationId) {
        await api.bindWorkstation(saved.id, workstationId || null);
        return { ...saved, workstationId: workstationId || null };
      }
      return saved;
    },
    onSuccess: (saved) => {
      client.setQueryData<Agent[]>(qk.agents, (list) =>
        list?.some((a) => a.id === saved.id) ? list.map((a) => (a.id === saved.id ? saved : a)) : [...(list ?? []), saved],
      );
      if (!agent) void navigate(`/agents/${saved.id}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAgent(agent?.id ?? ""),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.agents });
      void client.invalidateQueries({ queryKey: qk.channels });
      void navigate("/agents", { replace: true });
    },
  });
  const openChat = useMutation({
    mutationFn: () => api.openDm(agent?.id ?? ""),
    onSuccess: (channel) => void navigate(`/chat/${channel.id}`),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const noEndpoints = endpoints.isSuccess && endpoints.data.length === 0;

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 flex-1 flex-col rounded-card border border-line bg-surface/80 backdrop-blur xl:overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center gap-3 rounded-t-card border-b border-line bg-surface/95 px-5 py-4 backdrop-blur">
        <Link to="/agents" className="rounded-full p-1 text-muted hover:text-ink lg:hidden" aria-label="Back to agents"><ArrowLeft size={18} /></Link>
        <AgentAvatar seed={agent?.avatarSeed ?? form.name ?? "new"} size={44} state={agent?.state} label="avatar preview" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-extrabold tracking-tight">{form.name || "New agent"}</h2>
          <p className="truncate text-xs text-muted">{agent ? `Created ${new Date(agent.createdAt).toLocaleDateString()}` : "Not saved yet"}</p>
        </div>
        {agent ? (
          <Button size="sm" variant="ghost" icon={<MessagesSquare size={14} />} onClick={() => openChat.mutate()}>Chat</Button>
        ) : null}
        <Button type="submit" size="sm" variant="primary" disabled={save.isPending || noEndpoints}>
          {save.isPending ? "Saving…" : agent ? "Save" : "Create"}
        </Button>
      </header>

      <div className="space-y-8 px-5 py-6">
        <ErrorNote error={save.error ?? remove.error} />
        {noEndpoints ? (
          <p className="rounded-field border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
            Add a model endpoint in <Link className="underline" to="/settings">Settings</Link> before creating agents.
          </p>
        ) : null}

        <Section title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><TextInput value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={40} required placeholder="e.g. Ada" /></Field>
            <Field label="Role"><TextInput value={form.role} onChange={(e) => set("role", e.target.value)} maxLength={200} placeholder="e.g. Research lead" /></Field>
          </div>
          <Field label="Instructions" hint="Part of the stable system prompt. Changes apply from the next turn.">
            <TextArea rows={7} value={form.instructions} onChange={(e) => set("instructions", e.target.value)} maxLength={20000} placeholder="How should this agent behave? What does it own?" />
          </Field>
        </Section>

        <Section title="Model">
          <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <Field label="Endpoint">
              <Select value={endpointId} onChange={(e) => set("endpointId", e.target.value)} required>
                {(endpoints.data ?? []).map((ep) => <option key={ep.id} value={ep.id}>{ep.name}</option>)}
              </Select>
            </Field>
            <Field label="Model id" hint="As the endpoint names it, e.g. openai/gpt-5-mini on OpenRouter.">
              <TextInput value={form.modelId} onChange={(e) => set("modelId", e.target.value)} required className="font-mono" placeholder="provider/model" />
            </Field>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted">Thinking</legend>
            <div className="inline-flex rounded-pill border border-line bg-sunken p-1" role="radiogroup">
              {THINKING.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={form.thinkingLevel === level}
                  onClick={() => set("thinkingLevel", level)}
                  className={`rounded-pill px-3.5 py-1 text-sm font-semibold capitalize transition-colors ${form.thinkingLevel === level ? "bg-raised text-honey shadow-lift" : "text-muted hover:text-ink"}`}
                >
                  {level}
                </button>
              ))}
            </div>
          </fieldset>
        </Section>

        <Section title="Workstation" subtitle="Where this agent's workstation tools run. Reads are shared; one agent writes at a time.">
          <Field label="Assigned workstation">
            <Select value={workstationId} onChange={(e) => setWorkstationId(e.target.value)}>
              <option value="">None</option>
              {(workstations.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.osUser})</option>)}
            </Select>
          </Field>
        </Section>

        <Section title="Tools" subtitle="Agents start with no access. Each tool is checked again when it runs.">
          <GrantPicker grants={form.grants ?? []} onChange={(g) => set("grants", g)} />
        </Section>

        {agent ? (
          <Section title="Danger zone">
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Delete {agent.name}, its DM, runs and session? Usage totals are kept.</span>
                <Button size="sm" variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>Delete for good</Button>
                <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>Delete agent</Button>
            )}
          </Section>
        ) : null}
      </div>
    </form>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-extrabold tracking-tight text-honey">{title}</h3>
        <span className="h-px flex-1 bg-line" />
      </div>
      {subtitle ? <p className="-mt-2 text-xs text-faint">{subtitle}</p> : null}
      {children}
    </section>
  );
}
