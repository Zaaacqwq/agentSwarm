import type { ToolpackInfo } from "@hive/core";
import { isGranted, type AgentContext, type AnyHiveTool, type HealthReport, type Toolpack } from "./toolpack.ts";

export interface ResolvedTool {
  readonly toolpackId: string;
  readonly tool: AnyHiveTool;
}

export interface ResolvedToolset {
  readonly tools: readonly ResolvedTool[];
  readonly guidance: readonly string[];
}

export class ToolpackRegistry {
  private readonly packs = new Map<string, Toolpack>();
  private health = new Map<string, HealthReport>();

  register(pack: Toolpack): void {
    if (this.packs.has(pack.id)) throw new Error(`Toolpack ${pack.id} already registered`);
    this.packs.set(pack.id, pack);
  }

  has(toolpackId: string): boolean {
    return this.packs.has(toolpackId);
  }

  async refreshHealth(): Promise<void> {
    const entries = await Promise.all(
      [...this.packs.values()].map(async (p): Promise<[string, HealthReport]> => {
        try {
          return [p.id, await p.healthcheck()];
        } catch (error) {
          return [p.id, { available: false, reason: error instanceof Error ? error.message : "healthcheck failed" }];
        }
      }),
    );
    this.health = new Map(entries);
  }

  /** Tool metadata for the Agents UI; unavailable packs are shown, not hidden. */
  describe(probe: AgentContext): ToolpackInfo[] {
    return [...this.packs.values()].map((p) => {
      const h = this.health.get(p.id) ?? { available: false, reason: "not checked" };
      return {
        id: p.id,
        label: p.label,
        available: h.available,
        ...(h.reason ? { reason: h.reason } : {}),
        tools: p.tools(probe).map((t) => ({ name: t.name, label: t.label, access: t.access, description: t.description })),
      };
    });
  }

  /** Granted tools from healthy packs, each wrapped so execution re-checks the live grant. */
  resolve(ctx: AgentContext): ResolvedToolset {
    const tools: ResolvedTool[] = [];
    const guidance: string[] = [];
    for (const pack of this.packs.values()) {
      if (!this.health.get(pack.id)?.available) continue;
      const granted = pack.tools(ctx).filter((t) => isGranted(ctx.grants, pack.id, t.name));
      if (granted.length === 0) continue;
      if (pack.guidance) guidance.push(pack.guidance);
      for (const tool of granted) tools.push({ toolpackId: pack.id, tool: guard(pack.id, tool) });
    }
    return { tools, guidance };
  }
}

function guard(toolpackId: string, tool: AnyHiveTool): AnyHiveTool {
  return {
    ...tool,
    async execute(ctx, params, signal) {
      if (!isGranted(ctx.currentGrants(), toolpackId, tool.name)) {
        return { text: `Permission denied: ${tool.name} is not granted to this agent.`, isError: true };
      }
      return tool.execute(ctx, params, signal);
    },
  };
}
