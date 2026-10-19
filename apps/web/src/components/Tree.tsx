import type { RunView, TreeView } from "@agentswarm/contracts";
import { money } from "../api.ts";
import { useLive, useResource } from "../live.ts";
import { Link } from "../router.tsx";
import { Badge, RuntimeTag } from "./ui.tsx";

/** Every run of one tree, nested by parent, live. */
export function Tree({ treeId, current }: { treeId: string; current: string }) {
  const tree = useResource<TreeView>(`/trees/${treeId}`);
  useLive((m) => {
    if (m.kind !== "run" || m.run.treeId !== treeId) return;
    tree.set((prev) => {
      if (!prev) return prev;
      const nodes = prev.nodes.some((n) => n.id === m.run.id) ? prev.nodes.map((n) => (n.id === m.run.id ? m.run : n)) : [...prev.nodes, m.run];
      return { ...prev, nodes, totalCostUsd: nodes.reduce((s, n) => s + n.costUsd, 0) };
    });
  });
  if (!tree.data || tree.data.nodes.length < 2) return null;
  const byParent = new Map<string | null, RunView[]>();
  for (const n of tree.data.nodes) byParent.set(n.parentRunId, [...(byParent.get(n.parentRunId) ?? []), n]);
  const root = tree.data.nodes.find((n) => n.parentRunId === null);
  return (
    <section className="card" aria-labelledby="tree-head">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="tree-head">Agent tree</h2>
        <span className="faint">{tree.data.nodes.length} agents · {money(tree.data.totalCostUsd)} in total</span>
      </div>
      {root && <ul className="tree" role="tree"><Node node={root} byParent={byParent} current={current} /></ul>}
    </section>
  );
}

function Node({ node, byParent, current }: { node: RunView; byParent: Map<string | null, RunView[]>; current: string }) {
  const kids = byParent.get(node.id) ?? [];
  return (
    <li role="treeitem" aria-expanded={kids.length ? true : undefined} aria-current={node.id === current ? "true" : undefined}>
      <div className={`tree-node${node.id === current ? " here" : ""}`}>
        <Badge status={node.status} />
        <Link to={`/agents/${node.agentId}/runs/${node.id}`}><b>{node.agentName}</b></Link>
        <span className="faint">{node.kind === "review" ? "reviewer" : node.agentRole}</span>
        <RuntimeTag runtime={node.runtime} />
        {node.review && <Badge status={node.review.approved ? "ok" : "bad"}>{node.review.approved ? "approved" : "changes requested"}</Badge>}
        {node.mergedAt && <Badge status="pushed">merged</Badge>}
        {node.prUrl && <a href={node.prUrl} target="_blank" rel="noreferrer">pull request ↗</a>}
        <span className="faint mono">{node.kind === "review" ? "" : node.branch.split("/").pop()}</span>
        <span className="faint">{node.runtime === "native" ? money(node.costUsd) : `≈${money(node.estimatedUsd)} subscription`}</span>
      </div>
      {kids.length > 0 && <ul role="group">{kids.map((k) => <Node key={k.id} node={k} byParent={byParent} current={current} />)}</ul>}
    </li>
  );
}
