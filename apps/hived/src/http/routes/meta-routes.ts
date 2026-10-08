import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { ToolpackInfo, UsageSummary } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";

export const metaRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { registry, runs } = deps.services;

  app.get("/toolpacks", { schema: { response: { 200: Type.Array(ToolpackInfo) } } }, async (request) => {
    const user = requireUser(request);
    return registry.describe({ agentId: "", orgId: user.orgId, runId: "", grants: [], currentGrants: () => [] });
  });

  app.get("/usage", { schema: { response: { 200: UsageSummary } } }, async (request) => runs.usageSummary(requireUser(request).orgId));
};
