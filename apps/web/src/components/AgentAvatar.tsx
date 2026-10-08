import type { AgentState } from "@hive/core";
import { avatarTraits } from "../lib/avatar.ts";

interface AgentAvatarProps {
  seed: string;
  size?: number;
  state?: AgentState;
  label?: string;
}

const STATE_COLOR: Record<AgentState, string> = {
  idle: "var(--color-ok)",
  queued: "var(--color-info)",
  working: "var(--color-honey)",
  error: "var(--color-err)",
};

/** A rounded block face generated from the agent's seed. */
export function AgentAvatar({ seed, size = 40, state, label }: AgentAvatarProps) {
  const t = avatarTraits(seed);
  const body = `oklch(72% 0.13 ${t.hue})`;
  const shade = `oklch(60% 0.13 ${t.hue})`;
  const ink = `oklch(22% 0.03 ${t.hue})`;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} role="img" aria-label={label ?? "agent avatar"}>
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
        <g transform={`rotate(${t.tilt} 20 20)`}>
          <rect x="3" y="5" width="34" height="32" rx="11" fill={shade} />
          <rect x="3" y="3" width="34" height="31" rx="11" fill={body} />
          <Eyes kind={t.eyes} ink={ink} />
          <Mouth kind={t.mouth} ink={ink} />
          {t.cheeks ? (
            <>
              <circle cx="10.5" cy="22" r="2.4" fill="oklch(75% 0.12 20 / 0.55)" />
              <circle cx="29.5" cy="22" r="2.4" fill="oklch(75% 0.12 20 / 0.55)" />
            </>
          ) : null}
        </g>
      </svg>
      {state ? (
        <span
          className={`absolute -right-0.5 -bottom-0.5 block rounded-full border-2 border-surface ${state === "working" ? "animate-pulse" : ""}`}
          style={{ width: Math.max(9, size / 4), height: Math.max(9, size / 4), background: STATE_COLOR[state] }}
          title={state}
        />
      ) : null}
    </span>
  );
}

function Eyes({ kind, ink }: { kind: number; ink: string }) {
  switch (kind) {
    case 0:
      return (<><circle cx="14" cy="16" r="2.4" fill={ink} /><circle cx="26" cy="16" r="2.4" fill={ink} /></>);
    case 1:
      return (<><rect x="11.5" y="15" width="5" height="2.4" rx="1.2" fill={ink} /><rect x="23.5" y="15" width="5" height="2.4" rx="1.2" fill={ink} /></>);
    case 2:
      return (<><path d="M11.5 17.5q2.5-3 5 0" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" /><path d="M23.5 17.5q2.5-3 5 0" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" /></>);
    default:
      return (<><circle cx="14" cy="16" r="3.2" fill="white" /><circle cx="14.6" cy="16.4" r="1.7" fill={ink} /><circle cx="26" cy="16" r="3.2" fill="white" /><circle cx="26.6" cy="16.4" r="1.7" fill={ink} /></>);
  }
}

function Mouth({ kind, ink }: { kind: number; ink: string }) {
  switch (kind) {
    case 0:
      return <path d="M15 24q5 4.5 10 0" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />;
    case 1:
      return <rect x="16.5" y="23.5" width="7" height="2.2" rx="1.1" fill={ink} />;
    case 2:
      return <ellipse cx="20" cy="25" rx="2.6" ry="2.2" fill={ink} />;
    default:
      return <path d="M15.5 24.5q2.2 2 4.5 0q2.3 2 4.5 0" stroke={ink} strokeWidth="1.8" fill="none" strokeLinecap="round" />;
  }
}
