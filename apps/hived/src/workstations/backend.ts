import { existsSync } from "node:fs";
import { dispatch, PRODUCTION_LAYOUT, WS_USER_PATTERN, type ErrorCode, type ExecEnv, type Layout, type Request, type Response } from "@hive/priv-helper";

export const HIVE_EXEC_PATH = "/usr/local/libexec/hive/hive-exec";

export class WorkstationError extends Error {
  constructor(
    readonly code: ErrorCode | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface BackendHealth {
  readonly ready: boolean;
  readonly reason?: string;
}

/** Where workstation operations actually execute. Swappable: macOS users today, VMs or other Macs later. */
export interface WorkstationBackend {
  readonly kind: "macos-user" | "local-fake";
  readonly layout: Layout;
  call<T = unknown>(osUser: string, request: Request, timeoutMs?: number): Promise<T>;
  health(): Promise<BackendHealth>;
}

function unwrap<T>(response: Response): T {
  if (!response.ok) throw new WorkstationError(response.code, response.error);
  return response.result as T;
}

/** Runs hive-exec as the workstation's macOS user through the narrow sudoers rule. */
export class MacosUserBackend implements WorkstationBackend {
  readonly kind = "macos-user" as const;
  readonly layout = PRODUCTION_LAYOUT;

  constructor(private readonly execPath = HIVE_EXEC_PATH) {}

  async call<T>(osUser: string, request: Request, timeoutMs = 660_000): Promise<T> {
    if (!WS_USER_PATTERN.test(osUser)) throw new WorkstationError("bad_request", `Not a workstation user: ${osUser}`);
    const proc = Bun.spawn(["/usr/bin/sudo", "-n", "-u", osUser, this.execPath], {
      stdin: new TextEncoder().encode(JSON.stringify(request)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      env: { PATH: "/usr/bin:/bin" },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (!out.trim()) throw new WorkstationError("unavailable", err.trim().slice(0, 300) || "hive-exec returned nothing");
    let parsed: Response;
    try {
      parsed = JSON.parse(out) as Response;
    } catch {
      throw new WorkstationError("failed", "hive-exec returned malformed output");
    }
    return unwrap<T>(parsed);
  }

  async health(): Promise<BackendHealth> {
    if (!existsSync(this.execPath)) return { ready: false, reason: "hive-exec is not installed; run scripts/setup-workstations.sh" };
    return this.volumeHealth();
  }

  /** The workstation volume is mounted with ownership enforced (required for hived's own data too). */
  volumeHealth(): BackendHealth {
    const mount = Bun.spawnSync(["/sbin/mount"]).stdout.toString();
    const line = mount.split("\n").find((l) => l.includes(` on ${this.layout.volume} `));
    if (!line) return { ready: false, reason: `${this.layout.volume} is not mounted` };
    if (line.includes("noowners")) return { ready: false, reason: `${this.layout.volume} is mounted with noowners` };
    const info = Bun.spawnSync(["/usr/sbin/diskutil", "info", this.layout.volume]).stdout.toString();
    if (!/Owners:\s+Enabled/.test(info)) return { ready: false, reason: `${this.layout.volume} does not have ownership enabled` };
    return { ready: true };
  }
}

/** In-process backend over a temp layout: same op code as hive-exec, no sudo. For tests and demos. */
export class LocalBackend implements WorkstationBackend {
  readonly kind = "local-fake" as const;

  constructor(
    readonly layout: Layout,
    private readonly homeOf: (osUser: string) => string,
    private readonly sandbox = true,
  ) {}

  async call<T>(osUser: string, request: Request): Promise<T> {
    if (!WS_USER_PATTERN.test(osUser)) throw new WorkstationError("bad_request", `Not a workstation user: ${osUser}`);
    const root = `${this.layout.wsRoot}/${osUser}`;
    if (!existsSync(root)) throw new WorkstationError("unavailable", `Workstation root ${root} is missing`);
    const env: ExecEnv = { user: osUser, home: this.homeOf(osUser), root, layout: this.layout, sandbox: this.sandbox };
    return unwrap<T>(await dispatch(env, request));
  }

  async health(): Promise<BackendHealth> {
    return existsSync(this.layout.wsRoot) ? { ready: true } : { ready: false, reason: "local layout missing" };
  }
}
