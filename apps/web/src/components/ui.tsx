import { useState, type FormEvent, type ReactNode } from "react";
import type { AgentRuntime } from "@agentswarm/contracts";

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge ${status}`}>{children ?? status}</span>;
}

export function PageHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        {label}
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column" }}>{children}</div>
      </label>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** A form whose submit handler may throw; the message is shown under the button. */
export function Form({ onSubmit, submit, children }: { onSubmit: () => Promise<void>; submit: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={handle}>
      {children}
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>{busy ? "Working…" : submit}</button>
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </form>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

const RUNTIME_LABEL: Record<AgentRuntime, string> = { native: "native", claude_code: "Claude Code", codex: "Codex" };

/** Who does an agent's work; native agents show nothing (they are the default). */
export function RuntimeTag({ runtime }: { runtime: AgentRuntime }) {
  if (runtime === "native") return null;
  return <span className={`runtime ${runtime}`} title="Runs on your subscription">{RUNTIME_LABEL[runtime]}</span>;
}

/** A share used (0–1) against its limit: a thin bar that turns warn past the limit. */
export function Meter({ label, value, limit, note }: { label: string; value: number; limit: number; note?: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="meter">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>{label}</span>
        <span className="mono">{pct}%{note ? <span className="faint"> · {note}</span> : null}</span>
      </div>
      <div className={`meter-bar${value >= limit ? " over" : ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ transform: `scaleX(${Math.min(1, value)})` }} />
        <i style={{ left: `${Math.round(limit * 100)}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}
