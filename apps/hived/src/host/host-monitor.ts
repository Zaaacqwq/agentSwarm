import { statfsSync } from "node:fs";
import type { HostStatus, PressureLevel } from "@hive/core";

export interface HostProbe {
  pressureLevel(): PressureLevel;
  swapUsedMb(): number;
  disk(mount: string): { freeGb: number; totalGb: number } | null;
}

/** Reads macOS memory pressure, swap and disk space without spawning a shell. */
export const macProbe: HostProbe = {
  pressureLevel() {
    const out = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).stdout.toString().trim();
    return ({ "1": "normal", "2": "warn", "4": "critical" } as Record<string, PressureLevel>)[out] ?? "unknown";
  },
  swapUsedMb() {
    const out = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "vm.swapusage"]).stdout.toString();
    const used = /used = ([\d.]+)M/.exec(out)?.[1];
    return used ? Math.round(Number(used)) : 0;
  },
  disk(mount) {
    try {
      const s = statfsSync(mount);
      const gb = (blocks: number) => Math.round(((blocks * s.bsize) / 1024 ** 3) * 10) / 10;
      return { freeGb: gb(s.bavail), totalGb: gb(s.blocks) };
    } catch {
      return null;
    }
  },
};

export interface HostMonitorDeps {
  readonly probe: HostProbe;
  readonly mounts: readonly string[];
  readonly heavyStats: () => HostStatus["heavyTasks"];
  readonly workstations: () => Promise<{ ready: boolean; reason?: string }>;
  readonly onChange: (status: HostStatus) => void;
}

export class HostMonitor {
  private status: HostStatus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: HostMonitorDeps) {}

  current(): HostStatus | null {
    return this.status;
  }

  underPressure(): boolean {
    const level = this.status?.pressure;
    return level === "warn" || level === "critical";
  }

  async sample(now = Date.now()): Promise<HostStatus> {
    const ws = await this.deps.workstations();
    const next: HostStatus = {
      pressure: this.deps.probe.pressureLevel(),
      swapUsedMb: this.deps.probe.swapUsedMb(),
      disks: this.deps.mounts.flatMap((mount) => {
        const d = this.deps.probe.disk(mount);
        return d ? [{ mount, ...d }] : [];
      }),
      heavyTasks: this.deps.heavyStats(),
      workstationsReady: ws.ready,
      ...(ws.reason ? { workstationsReason: ws.reason } : {}),
      sampledAt: now,
    };
    const changed = JSON.stringify({ ...this.status, sampledAt: 0 }) !== JSON.stringify({ ...next, sampledAt: 0 });
    this.status = next;
    if (changed) this.deps.onChange(next);
    return next;
  }

  start(intervalMs = 10_000): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
