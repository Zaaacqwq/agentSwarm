import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { ToolGrant } from "@hive/core";
import { ToolpackRegistry } from "../src/registry.ts";
import { defineHiveTool, type AgentContext, type Toolpack } from "../src/toolpack.ts";

function pack(id: string, healthy = true, names = ["a", "b"]): Toolpack {
  return {
    id,
    label: id,
    guidance: `${id} guidance`,
    healthcheck: async () => (healthy ? { available: true } : { available: false, reason: "missing dependency" }),
    tools: () =>
      names.map((name) =>
        defineHiveTool({
          name,
          label: name,
          access: "r",
          description: name,
          parameters: Type.Object({}),
          execute: async () => ({ text: `${id}.${name} ran` }),
        }),
      ),
  };
}

function ctx(grants: ToolGrant[], live: ToolGrant[] = grants): AgentContext {
  return { agentId: "agt_1", orgId: "org_1", runId: "run_1", grants, currentGrants: () => live };
}

describe("ToolpackRegistry", () => {
  test("agents get no tools by default", async () => {
    const reg = new ToolpackRegistry();
    reg.register(pack("p"));
    await reg.refreshHealth();
    expect(reg.resolve(ctx([])).tools).toHaveLength(0);
  });

  test("resolves per-tool and wildcard grants, with guidance only for active packs", async () => {
    const reg = new ToolpackRegistry();
    reg.register(pack("p"));
    reg.register(pack("q"));
    await reg.refreshHealth();
    const one = reg.resolve(ctx([{ toolpackId: "p", toolName: "b" }]));
    expect(one.tools.map((t) => t.tool.name)).toEqual(["b"]);
    expect(one.guidance).toEqual(["p guidance"]);
    const all = reg.resolve(ctx([{ toolpackId: "q", toolName: "*" }]));
    expect(all.tools.map((t) => `${t.toolpackId}.${t.tool.name}`)).toEqual(["q.a", "q.b"]);
  });

  test("unhealthy packs are excluded but still described with a reason", async () => {
    const reg = new ToolpackRegistry();
    reg.register(pack("broken", false));
    await reg.refreshHealth();
    expect(reg.resolve(ctx([{ toolpackId: "broken", toolName: "*" }])).tools).toHaveLength(0);
    const [info] = reg.describe(ctx([]));
    expect(info).toMatchObject({ id: "broken", available: false, reason: "missing dependency" });
    expect(info!.tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("a throwing healthcheck marks the pack unavailable", async () => {
    const reg = new ToolpackRegistry();
    reg.register({ ...pack("x"), healthcheck: async () => { throw new Error("boom"); } });
    await reg.refreshHealth();
    expect(reg.describe(ctx([]))[0]).toMatchObject({ available: false, reason: "boom" });
  });

  test("execution re-checks live grants so a mid-run revoke denies the call", async () => {
    const reg = new ToolpackRegistry();
    reg.register(pack("p"));
    await reg.refreshHealth();
    const granted: ToolGrant[] = [{ toolpackId: "p", toolName: "a" }];
    const [resolved] = reg.resolve(ctx(granted)).tools;
    expect((await resolved!.tool.execute(ctx(granted), {})).text).toBe("p.a ran");
    const denied = await resolved!.tool.execute(ctx(granted, []), {});
    expect(denied).toMatchObject({ isError: true });
    expect(denied.text).toContain("Permission denied");
  });

  test("duplicate registration is rejected", () => {
    const reg = new ToolpackRegistry();
    reg.register(pack("p"));
    expect(() => reg.register(pack("p"))).toThrow("already registered");
    expect(reg.has("p")).toBe(true);
  });
});
