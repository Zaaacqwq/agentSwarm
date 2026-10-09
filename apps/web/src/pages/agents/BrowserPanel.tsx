import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, RotateCcw } from "lucide-react";
import type { Agent } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { Button } from "../../components/ui/Button.tsx";
import { relativeTime } from "../../lib/format.ts";
import { countdown, useNow } from "../../lib/time.ts";

/** The agent's own headless Chrome: when it was used, which sites it may write to, and a reset. */
export function BrowserPanel({ agent }: { agent: Agent }) {
  const client = useQueryClient();
  const now = useNow(5000);
  const profile = useQuery({ queryKey: qk.agentBrowser(agent.id), queryFn: () => api.agentBrowser(agent.id) });
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  const reset = useMutation({
    mutationFn: () => api.resetBrowser(agent.id),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.agentBrowser(agent.id) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApproval(id),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.agentBrowser(agent.id) }),
  });
  const usesBrowser = agent.grants.some((g) => g.toolpackId === "core.browser");
  const p = profile.data;
  if (!p || (!usesBrowser && !p.exists)) return null;
  const isAdmin = session.data?.user?.role === "admin";
  return (
    <section className="mt-3 rounded-xl border border-line bg-sunken px-3 py-2.5" aria-label="Browser">
      <div className="flex items-center gap-2 text-xs">
        <Globe size={13} className="text-info" aria-hidden />
        <span className="font-semibold">Browser</span>
        <span className="text-faint">{p.exists && p.lastUsedAt ? `used ${relativeTime(p.lastUsedAt, now)}` : "not used yet"}</span>
        {isAdmin && p.exists ? (
          <Button size="sm" variant="quiet" className="ml-auto h-6 px-2" icon={<RotateCcw size={11} />} disabled={reset.isPending}
            onClick={() => {
              if (window.confirm(`Clear ${agent.name}'s browser profile (cookies, logins, storage)?`)) reset.mutate();
            }}>
            Clear profile
          </Button>
        ) : null}
      </div>
      {p.siteApprovals.length ? (
        <ul className="mt-2 space-y-1">
          {p.siteApprovals.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-xs">
              <span className="truncate font-mono text-ok">{a.scope}</span>
              <span className="text-faint">writes allowed · {countdown((a.expiresAt ?? now) - now)}</span>
              {isAdmin ? <button className="ml-auto text-err hover:underline" onClick={() => revoke.mutate(a.id)}>end</button> : null}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-faint">Read-only everywhere; form posts ask you first.</p>}
      {reset.error ? <p role="alert" className="mt-1 text-xs text-err">{reset.error.message}</p> : null}
    </section>
  );
}
