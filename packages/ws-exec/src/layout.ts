/** Fixed on-disk layout. Built into ws-exec; never taken from a request. */
export interface Layout {
  /** The SwarmWS volume (APFS, ownership enabled). */
  readonly volume: string;
  /** Workstation roots: <wsRoot>/<os-user>, owned by that user, mode 0700. */
  readonly wsRoot: string;
  /** Bare mirrors kept by swarmd; workstations may read them. */
  readonly mirrors: string;
  /** Push inboxes: <inbox>/<os-user>.git, written by that user, read by swarmd. */
  readonly inbox: string;
  /** swarmd's private data; always denied to workstations. */
  readonly swarmdData: string;
  /** agentSwarm's own Node runtime for agent commands. */
  readonly nodeBin: string;
  /** swarmd's port on loopback; agent commands may not connect to it. */
  readonly swarmdPort: number;
  /** Pinned CLI workers (R4): <cliDir>/claude/claude and <cliDir>/codex/bin/codex, installed by scripts/setup.sh. */
  readonly cliDir: string;
}

export const PRODUCTION_LAYOUT: Layout = {
  volume: "/Volumes/SwarmWS",
  wsRoot: "/Volumes/SwarmWS/ws",
  mirrors: "/Volumes/SwarmWS/mirrors",
  inbox: "/Volumes/SwarmWS/inbox",
  swarmdData: "/Volumes/SwarmWS/swarmd",
  nodeBin: "/usr/local/libexec/agentswarm/node/bin",
  swarmdPort: 4318,
  cliDir: "/usr/local/libexec/agentswarm/cli",
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
  /** `reap` may kill every process of the user. True only in the installed ws-exec, never in tests. */
  readonly reapAll: boolean;
}
