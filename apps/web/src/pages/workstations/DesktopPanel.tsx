import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, MonitorOff, Pause, Play, Square } from "lucide-react";
import type { Agent, DesktopStatus } from "@hive/core";
import { api, qk } from "../../app/api.ts";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { countdown, useNow } from "../../lib/time.ts";

const REFRESH_MS = 2000;

/** This Mac's console desktop: who controls it, a live view for admins, and the stop button. */
export function DesktopPanel({ agents }: { agents: Map<string, Agent> }) {
  const status = useQuery({ queryKey: qk.desktop, queryFn: api.desktop, refetchInterval: 10_000 });
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  const isAdmin = session.data?.user?.role === "admin";
  const d = status.data;
  if (!d) return <p className="px-1 text-sm text-muted">Checking the desktop helper…</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {d.available && d.screenRecording && isAdmin ? <LiveView status={d} /> : <Unavailable status={d} isAdmin={isAdmin} />}
      <aside className="space-y-3">
        <HolderCard status={d} agents={agents} isAdmin={isAdmin} />
        <section className="rounded-card border border-line bg-surface/80 p-4">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-faint">Hive Desktop</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <Check ok={d.available} label="Helper running" />
            <Check ok={d.screenRecording} label="Screen Recording" />
            <Check ok={d.accessibility} label="Accessibility" />
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Agents can only look and click inside a session you approve. System Settings, Keychain Access, Terminal,
            password managers and this page are always off limits, and the menu bar shows ⬢ Hive with a stop item while a session runs.
          </p>
        </section>
      </aside>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? <CircleCheck size={15} className="text-ok" aria-hidden /> : <CircleX size={15} className="text-err" aria-hidden />}
      <span className={ok ? "" : "text-muted"}>{label}</span>
      <span className="sr-only">{ok ? "granted" : "missing"}</span>
    </li>
  );
}

function HolderCard({ status, agents, isAdmin }: { status: DesktopStatus; agents: Map<string, Agent>; isAdmin: boolean }) {
  const now = useNow();
  const stop = useMutation({ mutationFn: api.stopDesktop });
  const holder = status.holder;
  const agent = holder ? agents.get(holder.agentId) : undefined;
  return (
    <section className={`rounded-card border p-4 ${holder ? "border-honey/50 bg-surface shadow-glow" : "border-line bg-sunken/70"}`} aria-live="polite">
      <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-faint">Control session</h2>
      {holder ? (
        <>
          <div className="mt-3 flex items-center gap-3">
            {agent ? <AgentAvatar seed={agent.avatarSeed} state={agent.state} size={36} label={agent.name} /> : null}
            <div className="min-w-0">
              <p className="truncate font-bold">{holder.agentName}</p>
              <p className="font-mono text-xs text-honey">{countdown(holder.until - now)} left</p>
            </div>
          </div>
          {isAdmin ? (
            <Button variant="danger" size="sm" className="mt-3 w-full" icon={<Square size={12} />} disabled={stop.isPending} onClick={() => stop.mutate()}>
              Stop now
            </Button>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">Nobody is controlling this Mac.</p>
      )}
    </section>
  );
}

function Unavailable({ status, isAdmin }: { status: DesktopStatus; isAdmin: boolean }) {
  return (
    <section className="grid min-h-72 place-items-center rounded-card border border-dashed border-line bg-sunken/50 p-8 text-center">
      <div className="max-w-md space-y-2 text-sm text-muted">
        <MonitorOff className="mx-auto text-faint" size={28} aria-hidden />
        {!isAdmin ? <p>Only admins can see this Mac's screen.</p> : !status.available ? (
          <>
            <p className="font-semibold text-ink">Hive Desktop is not running.</p>
            <p>Install it once (no sudo): <code className="font-mono text-ink">zsh scripts/install-desktop-helper.sh</code></p>
            {status.reason ? <p className="text-xs text-faint">{status.reason}</p> : null}
          </>
        ) : (
          <>
            <p className="font-semibold text-ink">Hive Desktop needs permission.</p>
            <p>In System Settings → Privacy &amp; Security, turn on <strong className="text-ink">Hive Desktop</strong> under Screen &amp; System Audio Recording and Accessibility, then rerun the install script.</p>
          </>
        )}
      </div>
    </section>
  );
}

/** Refreshes every two seconds while visible; pausable. Never cached by the browser. */
function LiveView({ status }: { status: DesktopStatus }) {
  const [display, setDisplay] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [paused]);
  const current = status.displays.find((d) => d.index === display) ?? status.displays[0];
  return (
    <section className="overflow-hidden rounded-card border border-line bg-sunken" aria-label="Live view of this Mac">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`size-2 rounded-full ${paused ? "bg-faint" : "bg-err motion-safe:animate-pulse"}`} aria-hidden />
        <span className="text-xs font-semibold text-muted">{paused ? "Paused" : "Live"}</span>
        {status.displays.length > 1 ? (
          <div role="tablist" aria-label="Display" className="ml-2 flex rounded-pill border border-line p-0.5">
            {status.displays.map((d) => (
              <button
                key={d.index} role="tab" aria-selected={d.index === display} onClick={() => setDisplay(d.index)}
                className={`rounded-pill px-2.5 py-0.5 text-xs ${d.index === display ? "bg-raised text-ink" : "text-faint hover:text-ink"}`}
              >
                {d.main ? "Main" : `Display ${d.index + 1}`}
              </button>
            ))}
          </div>
        ) : null}
        <Button size="sm" variant="quiet" className="ml-auto" icon={paused ? <Play size={12} /> : <Pause size={12} />} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <div className="relative bg-black" style={{ aspectRatio: current ? `${current.imageWidth} / ${current.imageHeight}` : "16 / 9" }}>
        <img
          src={api.desktopScreenUrl(display, tick)} alt="This Mac's screen" width={current?.imageWidth} height={current?.imageHeight}
          className="absolute inset-0 size-full object-contain" onError={() => setFailed(true)} onLoad={() => setFailed(false)}
        />
        {failed ? <p className="absolute inset-x-0 bottom-3 text-center text-xs text-warn">Could not capture the screen.</p> : null}
      </div>
    </section>
  );
}
