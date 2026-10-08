import { useQuery } from "@tanstack/react-query";
import type { ToolGrant } from "@hive/core";
import { api, qk } from "../../app/api.ts";

const ACCESS_LABEL: Record<string, string> = { r: "read", w: "write", rw: "read/write", claim: "lease" };

export function GrantPicker({ grants, onChange }: { grants: readonly ToolGrant[]; onChange: (g: ToolGrant[]) => void }) {
  const packs = useQuery({ queryKey: qk.toolpacks, queryFn: api.toolpacks });

  const has = (packId: string, tool: string) => grants.some((g) => g.toolpackId === packId && (g.toolName === "*" || g.toolName === tool));
  const all = (packId: string) => grants.some((g) => g.toolpackId === packId && g.toolName === "*");

  const togglePack = (packId: string) => {
    const rest = grants.filter((g) => g.toolpackId !== packId);
    onChange(all(packId) ? rest : [...rest, { toolpackId: packId, toolName: "*" }]);
  };

  const toggleTool = (packId: string, tool: string, toolNames: string[]) => {
    const rest = grants.filter((g) => g.toolpackId !== packId);
    const current = new Set(toolNames.filter((t) => has(packId, t)));
    if (current.has(tool)) current.delete(tool);
    else current.add(tool);
    const next = current.size === toolNames.length ? [{ toolpackId: packId, toolName: "*" }] : [...current].map((t) => ({ toolpackId: packId, toolName: t }));
    onChange([...rest, ...next]);
  };

  return (
    <div className="space-y-3">
      {(packs.data ?? []).map((pack) => {
        const names = pack.tools.map((t) => t.name);
        return (
          <div key={pack.id} className={`overflow-hidden rounded-2xl border ${all(pack.id) ? "border-honey/40" : "border-line"} bg-sunken/70`}>
            <label className="flex items-center gap-3 border-b border-line px-4 py-3">
              <input type="checkbox" className="size-4 accent-[var(--color-honey)]" checked={all(pack.id)} onChange={() => togglePack(pack.id)} disabled={!pack.available} />
              <span className="flex-1">
                <span className="font-semibold">{pack.label}</span>
                <span className="ml-2 font-mono text-[0.7rem] text-faint">{pack.id}</span>
              </span>
              {!pack.available ? <span className="rounded-pill bg-err/10 px-2 py-0.5 text-xs text-err" title={pack.reason}>unavailable</span> : null}
            </label>
            <ul className="divide-y divide-line/60">
              {pack.tools.map((tool) => (
                <li key={tool.name}>
                  <label className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-raised/40">
                    <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-honey)]" checked={has(pack.id, tool.name)} onChange={() => toggleTool(pack.id, tool.name, names)} disabled={!pack.available} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <code className="font-mono text-sm">{tool.name}</code>
                        <span className="rounded-pill border border-line px-1.5 text-[0.65rem] text-muted">{ACCESS_LABEL[tool.access] ?? tool.access}</span>
                      </span>
                      <span className="block text-xs text-muted">{tool.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
