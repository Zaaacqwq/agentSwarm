import { useState, type FormEvent, type ReactNode } from "react";

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
