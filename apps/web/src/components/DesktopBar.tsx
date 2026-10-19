import { useEffect, useState } from "react";
import type { DesktopSessionView, DesktopView } from "@agentswarm/contracts";
import { api } from "../api.ts";
import { useLive, useResource } from "../live.ts";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The desktop (R9), on every page: an agent asking to use this Mac waits here for Approve or Deny, and an
 * active session can be stopped from here, whatever page (or phone) you are on.
 */
export function DesktopBar() {
  const desktop = useResource<DesktopView>("/desktop");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useLive((m) => void (m.kind === "desktop" && desktop.set(() => m.desktop)));
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const sessions = desktop.data?.sessions ?? [];
  const now = sessions.find((s) => s.status === "active" || s.status === "pending");
  if (!now) return null;
  const queued = sessions.filter((s) => s.status === "queued").length;
  const act = (path: string) => {
    setBusy(true);
    return api<unknown>("POST", path, {}).then(() => setError(null)).catch((e: Error) => setError(e.message)).finally(() => {
      setBusy(false);
      desktop.reload();
    });
  };
  return (
    <section className={`desktop-bar ${now.status}`} aria-label="Desktop" aria-live="polite">
      {now.status === "pending" ? <Ask s={now} /> : <Active s={now} />}
      <div className="row">
        {now.status === "pending" ? (
          <>
            <button className="btn signal" disabled={busy} onClick={() => void act(`/desktop/sessions/${now.id}/approve`)}>Approve</button>
            <button className="btn ghost" disabled={busy} onClick={() => void act(`/desktop/sessions/${now.id}/deny`)}>Deny</button>
          </>
        ) : (
          <button className="btn danger" disabled={busy} onClick={() => void act("/desktop/stop")}>Stop</button>
        )}
        {queued > 0 && <span className="faint">{queued} more waiting</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function Where({ s }: { s: DesktopSessionView }) {
  return <span className="faint">{s.ticketKey ? <a href={`/tickets/${s.ticketKey}`}>{s.ticketKey}</a> : s.runTitle} · {s.projectName}</span>;
}

function Ask({ s }: { s: DesktopSessionView }) {
  return (
    <div className="stack tight">
      <h2><b>{s.agent}</b> asks to use this Mac for {s.minutes} minutes</h2>
      {/* The agent's words, shown as such. */}
      <p className="desktop-purpose">“{s.purpose}”</p>
      <p className="faint">Only the app it builds can be seen and used, in the App Sandbox. Stop it any time here, in Discord or from the menu bar. <Where s={s} /></p>
    </div>
  );
}

function Active({ s }: { s: DesktopSessionView }) {
  const paused = s.pausedUntil !== null && s.pausedUntil > Date.now();
  return (
    <div className="stack tight">
      <h2><b>{s.agent}</b> is testing {s.app ?? "an app"} on this Mac</h2>
      <p className="faint">
        {paused ? "Paused while you use the Mac. " : ""}Ends at {s.until ? clock(s.until) : "?"}. <Where s={s} />
      </p>
    </div>
  );
}
