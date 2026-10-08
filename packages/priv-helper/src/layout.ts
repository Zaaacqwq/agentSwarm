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
}

export const PRODUCTION_LAYOUT: Layout = {
  volume: "/Volumes/HiveWS",
  wsRoot: "/Volumes/HiveWS/ws",
  mirrors: "/Volumes/HiveWS/mirrors",
  inbox: "/Volumes/HiveWS/inbox",
  hivedData: "/Volumes/HiveWS/hived",
  binDir: "/usr/local/libexec/hive/bin",
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
