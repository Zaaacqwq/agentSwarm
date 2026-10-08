import { NavLink, Outlet } from "react-router";
import { Bot, MessagesSquare, Server, Settings2 } from "lucide-react";
import { HostBanner } from "./HostBanner.tsx";
import type { LiveStatus } from "../app/live.ts";

const NAV = [
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/workstations", label: "Workstations", icon: Server },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

const LIVE_LABEL: Record<LiveStatus, { text: string; color: string }> = {
  live: { text: "live", color: "bg-ok" },
  connecting: { text: "connecting", color: "bg-warn" },
  offline: { text: "reconnecting", color: "bg-err" },
};

export function Shell({ live }: { live: LiveStatus }) {
  const status = LIVE_LABEL[live];
  return (
    <div className="flex h-dvh flex-col">
      <header className="relative z-10 flex items-center justify-between gap-4 px-4 pt-4 pb-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <HiveMark />
          <span className="text-[0.95rem] font-extrabold tracking-tight">Hive</span>
        </div>
        <nav aria-label="Main" className="absolute left-1/2 hidden -translate-x-1/2 sm:block">
          <PillNav />
        </nav>
        <span className="flex items-center gap-2 rounded-pill border border-line bg-surface/70 px-3 py-1 text-[0.7rem] font-semibold tracking-wide text-muted" aria-live="polite">
          <span className={`size-1.5 rounded-full ${status.color}`} />
          {status.text}
        </span>
      </header>
      <HostBanner />
      <main className="min-h-0 flex-1 px-2 pb-20 sm:px-6 sm:pb-6">
        <Outlet />
      </main>
      <nav aria-label="Main mobile" className="fixed inset-x-0 bottom-3 z-20 flex justify-center sm:hidden">
        <PillNav />
      </nav>
    </div>
  );
}

function PillNav() {
  return (
    <ul className="flex items-center gap-1 rounded-pill border border-line bg-surface/85 p-1 shadow-lift backdrop-blur-md">
      {NAV.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <NavLink
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-pill px-4 py-1.5 text-sm font-semibold transition-colors duration-[var(--duration-fast)] ${
                isActive ? "bg-honey text-honey-ink" : "text-muted hover:bg-raised hover:text-ink"
              }`
            }
          >
            <Icon size={15} strokeWidth={2.2} aria-hidden />
            <span className="max-sm:sr-only">{label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function HiveMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2l12 7v14l-12 7-12-7V9z" fill="var(--color-honey)" />
      <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="var(--color-honey-ink)" opacity="0.85" />
    </svg>
  );
}
