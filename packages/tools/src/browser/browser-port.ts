import type { AgentContext } from "../toolpack.ts";

export type BrowserAction =
  | { cmd: "open"; url: string }
  | { cmd: "snapshot" }
  | { cmd: "click"; ref: string }
  | { cmd: "type"; ref: string; text: string; submit?: boolean }
  | { cmd: "select"; ref: string; value: string }
  | { cmd: "screenshot"; full?: boolean }
  | { cmd: "back" }
  | { cmd: "tabs" };

export interface BrowserOutcome {
  readonly url: string;
  readonly title: string;
  readonly text?: string;
  readonly screenshot?: { readonly id: string; readonly data: string; readonly width: number; readonly height: number };
  /** Writes the guard stopped (e.g. "POST example.com"). */
  readonly blockedWrites?: readonly string[];
  /** A person's decision this call waited for, e.g. "approved form submissions on example.com for 30 min". */
  readonly approval?: string;
}

/**
 * What core.browser needs from hived: it runs the agent's own headless Chrome on its workstation,
 * asks a person when a site write needs approval, and stores screenshots. Throws Error with a
 * model-readable message on failure.
 */
export interface BrowserPort {
  run(ctx: AgentContext, action: BrowserAction): Promise<BrowserOutcome>;
}
