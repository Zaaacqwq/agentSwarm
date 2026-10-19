import { execFileSync } from "node:child_process";
import { statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import type { CheckItem } from "@agentswarm/contracts";
import type { Services } from "../app/services.ts";
import { WS_LAUNCH_PATH } from "../workstations/backend.ts";

export interface CheckOptions {
  readonly dataDir: string;
  readonly volume: string | null;
  readonly execPath?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** What the dashboard's System page shows; none of these need sudo. */
export function systemCheck(s: Services, o: CheckOptions, now = Date.now()): CheckItem[] {
  const items: CheckItem[] = [];
  const add = (name: string, ok: boolean, detail: string) => items.push({ name, ok, detail });

  const dataMode = safe(() => statSync(o.dataDir).mode & 0o777);
  add("Data directory is private", dataMode === 0o700, dataMode === null ? `${o.dataDir} is missing` : `${o.dataDir} mode ${dataMode.toString(8)}`);

  if (o.volume) {
    const info = safe(() => execFileSync("/usr/sbin/diskutil", ["info", o.volume!], { stdio: ["ignore", "pipe", "ignore"] }).toString()) ?? "";
    const mounts = safe(() => execFileSync("/sbin/mount", [], { stdio: ["ignore", "pipe", "ignore"] }).toString()) ?? "";
    const line = mounts.split("\n").find((l) => l.includes(` on ${o.volume} `)) ?? "";
    add("SwarmWS volume enforces ownership", /Owners:\s+Enabled/.test(info) && line !== "" && !line.includes("noowners"), line || `${o.volume} is not mounted`);
  }

  const execPath = o.execPath ?? WS_LAUNCH_PATH;
  const exec = safe(() => statSync(execPath));
  add("ws-launch is installed and root-owned", exec !== null && exec.uid === 0 && (exec.mode & 0o022) === 0, exec ? `${execPath} uid ${exec.uid} mode ${(exec.mode & 0o777).toString(8)}` : `${execPath} is missing; run scripts/setup.sh`);

  const ws = s.pool.list();
  const healthy = ws.filter((w) => w.status !== "unhealthy");
  add("Workstations are healthy", ws.length > 0 && healthy.length === ws.length, `${healthy.length} of ${ws.length} healthy${ws.filter((w) => w.lastError).map((w) => `; ${w.id}: ${w.lastError}`).join("")}`);

  const gh = s.github.status();
  const expiring = gh.expiresAt !== null && gh.expiresAt - now < 14 * DAY;
  add("GitHub token works", gh.configured && !gh.error && !expiring,
    !gh.configured ? "No token yet" : gh.error ?? (gh.expiresAt ? `${gh.login}, expires ${new Date(gh.expiresAt).toISOString().slice(0, 10)}${expiring ? " (soon)" : ""}` : `${gh.login}, no expiry`));

  const projects = s.projects.list();
  const unprotected = projects.filter((p) => !p.protectedAt);
  add("Default branches are protected", unprotected.length === 0, unprotected.length ? `Not protected: ${unprotected.map((p) => p.githubRepo).join(", ")}` : `${projects.length} project(s)`);

  const home = safe(() => statSync(homedir()).mode & 0o777);
  add("Your home folder is closed to other users", home !== null && (home & 0o007) === 0, home === null ? "unknown" : `mode ${home.toString(8)}${home & 0o007 ? " — run: chmod 750 ~" : ""}`);

  const free = safe(() => {
    const fs = statfsSync("/");
    return fs.bavail * fs.bsize;
  });
  add("Startup disk has room", free !== null && free > 10 * 1024 ** 3, free === null ? "unknown" : `${(free / 1024 ** 3).toFixed(1)} GB free`);
  return items;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
