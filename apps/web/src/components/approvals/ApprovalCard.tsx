import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, MessageCircleQuestion, MonitorSmartphone, ShieldCheck, ShieldX, TimerOff } from "lucide-react";
import type { Approval } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { countdown, useNow } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";

const KIND = {
  question: { icon: MessageCircleQuestion, label: "Question" },
  desktop: { icon: MonitorSmartphone, label: "Desktop control" },
  browser_site: { icon: Globe, label: "Site writes" },
} as const;

const MINUTES = [5, 15, 30, 60] as const;

/**
 * A request an agent is blocked on. Pending: answer or approve/deny (with a session length).
 * Approved sessions show their remaining time and can be revoked early.
 */
export function ApprovalCard({ approval: a, canDecide, compact = false }: { approval: Approval; canDecide: boolean; compact?: boolean }) {
  const now = useNow();
  const client = useQueryClient();
  const sessionMinutes = a.durationMs ? Math.round(a.durationMs / 60_000) : 15;
  const [minutes, setMinutes] = useState<number>(MINUTES.includes(sessionMinutes as never) ? sessionMinutes : 15);
  const [answer, setAnswer] = useState("");
  const onSettled = (next: Approval) => client.setQueryData<Approval[]>(qk.approvals, (list) => list?.map((x) => (x.id === next.id ? next : x)));
  const decide = useMutation({ mutationFn: (d: Parameters<typeof api.decideApproval>[1]) => api.decideApproval(a.id, d), onSuccess: onSettled });
  const revoke = useMutation({ mutationFn: () => api.revokeApproval(a.id), onSuccess: onSettled });
  const { icon: Icon, label } = KIND[a.kind];
  const pending = a.status === "pending";
  const active = a.status === "approved" && a.expiresAt !== null && a.expiresAt > now;
  const session = a.kind !== "question";

  const submitAnswer = (e: FormEvent) => {
    e.preventDefault();
    if (answer.trim()) decide.mutate({ decision: "approve", answer: answer.trim() });
  };

  return (
    <article
      aria-label={`${label} request from ${a.agentName}`}
      className={`relative w-full overflow-hidden rounded-card border text-left ${pending ? "border-honey/50 bg-surface shadow-glow" : active ? "border-ok/40 bg-surface/90" : "border-line bg-sunken/70"} ${compact ? "p-3.5" : "p-4"}`}
    >
      {pending ? <TimeBar from={a.createdAt} to={a.timeoutAt} now={now} /> : null}
      <header className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.12em]">
        <span className={`grid size-6 place-items-center rounded-lg ${pending ? "bg-honey text-honey-ink" : "bg-raised text-muted"}`}><Icon size={13} aria-hidden /></span>
        <span className={pending ? "text-honey" : "text-faint"}>{label}</span>
        <span className="text-faint normal-case tracking-normal">· {a.agentName}{a.scope && a.kind === "browser_site" ? ` · ${a.scope}` : ""}</span>
        <span className="ml-auto font-mono normal-case tracking-normal text-faint" aria-live="off">
          {pending ? `lapses in ${countdown(a.timeoutAt - now)}` : active ? `${countdown(a.expiresAt! - now)} left` : null}
        </span>
      </header>
      <p className={`mt-2.5 font-semibold leading-snug ${compact ? "text-sm" : "text-[0.98rem]"}`}>{a.question}</p>

      {pending && canDecide ? (
        a.kind === "question" ? (
          <div className="mt-3 space-y-2">
            {a.options.length ? (
              <div className="flex flex-wrap gap-2">
                {a.options.map((o) => (
                  <Button key={o} size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve", answer: o })}>{o}</Button>
                ))}
              </div>
            ) : null}
            <form onSubmit={submitAnswer} className="flex gap-2">
              <input
                value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={2000} placeholder={a.options.length ? "Or write an answer…" : "Write an answer…"}
                aria-label="Answer"
                className="h-8 min-w-0 flex-1 rounded-pill border border-line bg-sunken px-3 text-sm placeholder:text-faint focus:border-honey/60 focus:outline-none"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!answer.trim() || decide.isPending}>Send</Button>
              <Button size="sm" variant="quiet" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "deny" })}>Dismiss</Button>
            </form>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Session length" className="flex rounded-pill border border-line bg-sunken p-0.5">
              {MINUTES.map((m) => (
                <button
                  key={m} type="button" role="radio" aria-checked={minutes === m} onClick={() => setMinutes(m)}
                  className={`rounded-pill px-2.5 py-1 font-mono text-xs transition-colors ${minutes === m ? "bg-raised text-ink" : "text-faint hover:text-ink"}`}
                >
                  {m}m
                </button>
              ))}
            </div>
            <Button size="sm" variant="primary" icon={<ShieldCheck size={13} />} disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve", minutes })}>Approve</Button>
            <Button size="sm" variant="danger" icon={<ShieldX size={13} />} disabled={decide.isPending} onClick={() => decide.mutate({ decision: "deny" })}>Deny</Button>
          </div>
        )
      ) : null}
      {pending && !canDecide ? <p className="mt-2 text-xs text-faint">Waiting for an admin.</p> : null}

      {!pending ? (
        <footer className="mt-2 flex items-center gap-2 text-xs">
          <Outcome approval={a} active={active} session={session} />
          {active && canDecide ? (
            <Button size="sm" variant="danger" className="ml-auto" icon={<TimerOff size={13} />} disabled={revoke.isPending} onClick={() => revoke.mutate()}>End now</Button>
          ) : null}
        </footer>
      ) : null}
      {decide.error || revoke.error ? <p role="alert" className="mt-2 text-xs text-err">{(decide.error ?? revoke.error)!.message}</p> : null}
    </article>
  );
}

function Outcome({ approval: a, active, session }: { approval: Approval; active: boolean; session: boolean }) {
  switch (a.status) {
    case "approved":
      if (!session) return <span className="text-ok">{a.decidedBy} answered: <strong className="text-ink">{a.answer ?? "yes"}</strong></span>;
      return <span className={active ? "text-ok" : "text-faint"}>Approved by {a.decidedBy}{active ? "" : " · ended"}</span>;
    case "denied":
      return <span className="text-err">Declined by {a.decidedBy}</span>;
    case "revoked":
      return <span className="text-warn">Ended early</span>;
    case "expired":
      return <span className="text-faint">Nobody answered in time</span>;
    case "cancelled":
      return <span className="text-faint">Withdrawn</span>;
    default:
      return null;
  }
}

/** A thin honey bar draining toward the request's deadline. */
function TimeBar({ from, to, now }: { from: number; to: number; now: number }) {
  const left = Math.max(0, Math.min(1, (to - now) / Math.max(1, to - from)));
  return (
    <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-honey/15">
      <span className="block h-full origin-left bg-honey transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${left})` }} />
    </span>
  );
}
