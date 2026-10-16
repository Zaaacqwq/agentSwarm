/** Fixed on-disk layout. Built into ws-exec; never taken from a request. */
export interface Layout {
  /** The HiveWS volume (APFS, ownership enabled). */
  readonly volume: string;
  /** Workstation roots: <wsRoot>/<os-user>, owned by that user, mode 0700. */
  readonly wsRoot: string;
  /** Bare mirrors kept by hived; workstations may read them. */
  readonly mirrors: string;
  /** Push inboxes: <inbox>/<os-user>.git, written by that user, read by hived. */
  readonly inbox: string;
  /** hived's private data; always denied to workstations. */
  readonly hivedData: string;
  /** Hive's own Node runtime for agent commands. */
  readonly nodeBin: string;
}

export const PRODUCTION_LAYOUT: Layout = {
  volume: "/Volumes/HiveWS",
  wsRoot: "/Volumes/HiveWS/ws",
  mirrors: "/Volumes/HiveWS/mirrors",
  inbox: "/Volumes/HiveWS/inbox",
  hivedData: "/Volumes/HiveWS/hived",
  nodeBin: "/usr/local/libexec/hive/node/bin",
};

export const WS_USER_PATTERN = /^ws-[0-9]{1,2}$/;

/** What one ws-exec call works with, all derived from the OS user. */
export interface ExecEnv {
  readonly user: string;
  readonly home: string;
  /** <wsRoot>/<user> */
  readonly root: string;
  readonly layout: Layout;
  /** Wrap commands in sandbox-exec (off only in tests that do not run commands). */
  readonly sandbox: boolean;
}
