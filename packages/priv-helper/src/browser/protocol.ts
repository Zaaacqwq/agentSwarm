/** One request per line over the daemon's Unix socket; one JSON response per line back. */
export type BrowserCommand =
  | { cmd: "open"; url: string }
  | { cmd: "snapshot" }
  | { cmd: "click"; ref: string }
  | { cmd: "type"; ref: string; text: string; submit?: boolean }
  | { cmd: "select"; ref: string; value: string }
  | { cmd: "screenshot"; full?: boolean }
  | { cmd: "back" }
  | { cmd: "tabs" }
  | { cmd: "ping" }
  | { cmd: "shutdown" };

export interface BrowserRequest {
  readonly command: BrowserCommand;
  /** Hosts where this agent currently has an approved write session; decided by hived. */
  readonly approvedHosts: readonly string[];
}

export type BrowserResponse =
  | {
      ok: true;
      url: string;
      title: string;
      text?: string;
      /** Base64 JPEG and its size in pixels. */
      image?: string;
      width?: number;
      height?: number;
      /** Writes the guard aborted, e.g. "POST example.com" (deduplicated). */
      blockedWrites?: string[];
      /** Set when a blocked write was the page's own (form post or same-host API): approval would let it through. */
      blockedSite?: string;
    }
  | { ok: false; error: string; needsApproval?: { host: string; reason: string } };
