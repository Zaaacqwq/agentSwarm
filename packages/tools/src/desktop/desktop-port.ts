import type { AgentContext } from "../toolpack.ts";

export type DesktopAction =
  | { cmd: "screenshot"; display?: number }
  | { cmd: "click"; x: number; y: number; display?: number; button?: "left" | "right"; count?: number }
  | { cmd: "type"; text: string }
  | { cmd: "key"; combo: string }
  | { cmd: "scroll"; dx?: number; dy?: number; x?: number; y?: number; display?: number }
  | { cmd: "ui"; app?: string }
  | { cmd: "press"; element: number };

export interface DesktopOutcome {
  readonly text: string;
  readonly screenshot?: { readonly id: string; readonly data: string; readonly width: number; readonly height: number };
}

/**
 * What core.desktop needs from hived: an approved, leased control session over this Mac's
 * console desktop (via the hive-desktop helper). Throws Error with a model-readable message.
 */
export interface DesktopPort {
  acquire(ctx: AgentContext, reason: string, minutes: number): Promise<string>;
  release(ctx: AgentContext): Promise<string>;
  act(ctx: AgentContext, action: DesktopAction): Promise<DesktopOutcome>;
}
