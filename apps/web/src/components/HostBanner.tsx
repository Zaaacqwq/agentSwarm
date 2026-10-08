import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api, qk } from "../app/api.ts";

/** Surfaces host conditions that change agent behaviour: memory pressure, low disk, workstations offline. */
export function HostBanner() {
  const host = useQuery({ queryKey: qk.host, queryFn: api.host, refetchInterval: 30_000 });
  if (!host.data) return null;
  const notes: string[] = [];
  if (host.data.pressure === "warn" || host.data.pressure === "critical") {
    notes.push(`Memory pressure is ${host.data.pressure}; new commands wait until it clears.`);
  }
  for (const d of host.data.disks) if (d.freeGb < 10) notes.push(`${d.mount} has only ${d.freeGb} GB free.`);
  if (!host.data.workstationsReady) notes.push(`Workstations unavailable: ${host.data.workstationsReason ?? "not set up"}.`);
  if (notes.length === 0) return null;
  return (
    <div role="status" className="mx-2 mb-3 flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-2.5 text-sm text-warn sm:mx-6">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{notes.join(" ")}</span>
    </div>
  );
}
