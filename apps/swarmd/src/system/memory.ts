import { execFileSync } from "node:child_process";

/**
 * The kernel's memory pressure level: 1 normal, 2 warning, 4 critical (what Activity Monitor's graph shows).
 * Unknown counts as normal: a failed read must not stop every simulator run.
 */
export function memoryPressure(): number {
  try {
    const level = Number(execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 2000 }).trim());
    return Number.isInteger(level) && level > 0 ? level : 1;
  } catch {
    return 1;
  }
}
