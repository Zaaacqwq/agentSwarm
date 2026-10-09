import { useQuery } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { api, qk } from "../../app/api.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

/** Pending requests surface on every page: an agent is blocked until someone answers. */
export function ApprovalBanner() {
  const approvals = useQuery({ queryKey: qk.approvals, queryFn: api.approvals, refetchInterval: 60_000 });
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity });
  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  if (pending.length === 0) return null;
  const isAdmin = session.data?.user?.role === "admin";
  return (
    <section aria-label="Waiting for you" className="mx-2 mb-3 sm:mx-6">
      <h2 className="mb-2 flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-honey">
        <BellRing size={13} aria-hidden className="motion-safe:animate-pulse" />
        {pending.length === 1 ? "An agent is waiting for you" : `${pending.length} agents are waiting for you`}
      </h2>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {pending.slice(0, 3).map((a) => (
          <li key={a.id}><ApprovalCard approval={a} canDecide={isAdmin || a.kind === "question"} compact /></li>
        ))}
      </ul>
    </section>
  );
}
