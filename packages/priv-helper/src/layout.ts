/** Fixed on-disk layout of the workstation volume. Compiled into hive-exec; never taken from input. */
export interface Layout {
  /** Volume root, e.g. /Volumes/HiveWS */
  readonly volume: string;
  /** Per-user workstation roots live under here: <wsRoot>/<os-user> */
  readonly wsRoot: string;
  /** Bare mirrors maintained by hived, readable by workstation users */
  readonly mirrors: string;
  /** Per-user push inboxes: <inbox>/<os-user>.git */
  readonly inbox: string;
  /** hived's private data dir, always denied */
  readonly hivedData: string;
  /** Tools available to agents (pinned bun etc.) */
  readonly binDir: string;
  /** The agent browser daemon (daemon.js + node_modules/playwright-core), root-owned and world-readable */
  readonly browserDir: string;
  /**
   * Per-user browser state (<browserState>/<os-user>: control sockets, Chrome profiles), owned by the
   * workstation user but outside everything the agent sandbox allows, so an agent's shell can neither
   * talk to its browser directly nor read its cookies.
   */
  readonly browserState: string;
  /** Test-only exceptions to the browser's private-address block (never set in production). */
  readonly browserAllowHosts?: readonly string[];
}

export const PRODUCTION_LAYOUT: Layout = {
  volume: "/Volumes/HiveWS",
  wsRoot: "/Volumes/HiveWS/ws",
  mirrors: "/Volumes/HiveWS/mirrors",
  inbox: "/Volumes/HiveWS/inbox",
  hivedData: "/Volumes/HiveWS/hived",
  binDir: "/usr/local/libexec/hive/bin",
  browserDir: "/usr/local/libexec/hive/browser",
  browserState: "/Volumes/HiveWS/browser",
};

export const WS_USER_PATTERN = /^ws-[0-9]{1,3}$/;

/** The per-call environment hive-exec works in, derived from the OS user. */
export interface ExecEnv {
  readonly user: string;
  readonly home: string;
  /** This workstation's root: <wsRoot>/<user> */
  readonly root: string;
  readonly layout: Layout;
  /** Wrap commands in sandbox-exec (false only in unit tests of non-exec ops). */
  readonly sandbox: boolean;
}
