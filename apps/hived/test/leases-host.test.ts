import { describe, expect, test } from "bun:test";
import { LeaseService } from "../src/leases/lease-service.ts";
import { HeavySlots } from "../src/leases/heavy-slots.ts";
import { HostMonitor } from "../src/host/host-monitor.ts";
import { scanAddedLines } from "../src/git-relay/secret-scan.ts";
import { agentSlug } from "../src/repos/repo-service.ts";
import type { PressureLevel } from "@hive/core";
import { memoryDb } from "./helpers.ts";

describe("LeaseService", () => {
  test("one writer at a time, renewable, expiring, released per run", () => {
    const changes: string[] = [];
    const leases = new LeaseService(memoryDb().db, (r) => changes.push(r));
    const t = 1_000_000;
    expect(leases.acquire({ resourceId: "ws_1", agentId: "a", runId: "r1", ttlMs: 100 }, t).ok).toBe(true);
    const blocked = leases.acquire({ resourceId: "ws_1", agentId: "b", runId: "r2" }, t + 10);
    expect(blocked).toMatchObject({ ok: false, holder: { holderAgentId: "a" } });
    const renewed = leases.acquire({ resourceId: "ws_1", agentId: "a", runId: "r1", ttlMs: 100 }, t + 50);
    expect(renewed.ok && renewed.lease.expiresAt).toBe(t + 150);
    expect(leases.acquire({ resourceId: "ws_1", agentId: "b", runId: "r2" }, t + 151).ok).toBe(true);
    expect(leases.current("ws_1", t + 160)?.holderAgentId).toBe("b");
    leases.releaseForRun("r2", t + 170);
    expect(leases.current("ws_1", t + 171)).toBeNull();
    expect(leases.acquire({ resourceId: "ws_2", agentId: "c", runId: null }, t).ok).toBe(true);
    expect(leases.release("ws_2", "someone-else")).toBe(false);
    expect(leases.release("ws_2", "c")).toBe(true);
    leases.acquire({ resourceId: "ws_3", agentId: "d", runId: null });
    leases.releaseAll();
    expect(leases.current("ws_3")).toBeNull();
    expect(changes).toContain("ws_1");
  });
});

describe("HeavySlots", () => {
  test("caps concurrency and queues FIFO", async () => {
    const slots = new HeavySlots(1);
    const order: string[] = [];
    let release: () => void = () => {};
    const first = slots.run(() => new Promise<void>((r) => { order.push("a"); release = r; }), { waitMs: 1000 });
    const second = slots.run(async () => { order.push("b"); }, { waitMs: 1000 });
    await Bun.sleep(5);
    expect(slots.stats()).toEqual({ running: 1, waiting: 1, slots: 1 });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
    expect(slots.stats().running).toBe(0);
  });

  test("blocks while under pressure and times out with a reason", async () => {
    let pressure = true;
    const slots = new HeavySlots(2, () => pressure);
    await expect(slots.run(async () => 1, { waitMs: 20 })).rejects.toThrow("memory pressure");
    const pending = slots.run(async () => "ran", { waitMs: 1000 });
    pressure = false;
    slots.drain();
    expect(await pending).toBe("ran");
  });

  test("abort removes a waiter", async () => {
    const slots = new HeavySlots(1);
    let release: () => void = () => {};
    const busy = slots.run(() => new Promise<void>((r) => (release = r)), { waitMs: 1000 });
    const controller = new AbortController();
    const waiting = slots.run(async () => "never", { waitMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(slots.stats().waiting).toBe(0);
    release();
    await busy;
  });
});

describe("HostMonitor", () => {
  test("publishes only on change and reports pressure", async () => {
    let level: PressureLevel = "normal";
    const published: PressureLevel[] = [];
    const monitor = new HostMonitor({
      probe: { pressureLevel: () => level, swapUsedMb: () => 12, disk: (m) => (m === "/missing" ? null : { freeGb: 50, totalGb: 100 }) },
      mounts: ["/", "/missing"],
      heavyStats: () => ({ running: 0, waiting: 0, slots: 2 }),
      workstations: async () => ({ ready: false, reason: "not set up" }),
      onChange: (s) => published.push(s.pressure),
    });
    const first = await monitor.sample(1);
    expect(first).toMatchObject({ pressure: "normal", swapUsedMb: 12, workstationsReady: false, workstationsReason: "not set up" });
    expect(first.disks).toEqual([{ mount: "/", freeGb: 50, totalGb: 100 }]);
    await monitor.sample(2);
    expect(published).toEqual(["normal"]);
    level = "warn";
    await monitor.sample(3);
    expect(monitor.underPressure()).toBe(true);
    expect(published).toEqual(["normal", "warn"]);
    expect(monitor.current()?.sampledAt).toBe(3);
  });
});

describe("helpers", () => {
  test("secret scan looks only at added lines", () => {
    const diff = ["+++ b/x", `+const a = "AKIA${"A".repeat(16)}";`, `-const old = "ghp_${"x".repeat(36)}";`, "+-----BEGIN OPENSSH PRIVATE KEY-----"].join("\n");
    expect(scanAddedLines(diff).sort()).toEqual(["AWS access key", "private key"]);
    expect(scanAddedLines("+const ok = 1;")).toEqual([]);
  });

  test("agent slugs are branch-safe", () => {
    expect(agentSlug("Ada Lovelace", "agt_x")).toBe("ada-lovelace");
    expect(agentSlug("  !!  ", "agt_0123456789abcdef")).toBe("89abcdef");
  });
});
