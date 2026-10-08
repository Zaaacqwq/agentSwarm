import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { ActivityEvent, Agent, CreateAgent, IdParams, Ok, Run, UpdateAgent, UsageSummary } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";

const RunsQuery = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
const RunsWithActivity = Type.Object({ runs: Type.Array(Run), activity: Type.Array(ActivityEvent) });

export const agentRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { agents, manager, runs, bus } = deps.services;

  app.get("/", { schema: { response: { 200: Type.Array(Agent) } } }, async (request) => agents.list(requireUser(request)));

  app.post("/", { schema: { body: CreateAgent, response: { 200: Agent } } }, async (request) => {
    const user = requireUser(request);
    const agent = agents.create(user, request.body);
    bus.publish(user.orgId, { type: "agent.updated", agent });
    return agent;
  });

  app.get("/:id", { schema: { params: IdParams, response: { 200: Agent } } }, async (request) =>
    agents.get(requireUser(request), request.params.id),
  );

  app.patch("/:id", { schema: { params: IdParams, body: UpdateAgent, response: { 200: Agent } } }, async (request) => {
    const user = requireUser(request);
    const agent = agents.update(user, request.params.id, request.body);
    bus.publish(user.orgId, { type: "agent.updated", agent });
    return agent;
  });

  app.delete("/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (request) => {
    const user = requireUser(request);
    agents.getRow(user.orgId, request.params.id);
    manager.onAgentDeleted(request.params.id);
    await deps.services.repos.removeAgentWorktrees(request.params.id);
    agents.remove(user, request.params.id);
    bus.publish(user.orgId, { type: "agent.deleted", agentId: request.params.id });
    return { ok: true as const };
  });

  app.post("/:id/stop", { schema: { params: IdParams, response: { 200: Type.Object({ stopped: Type.Boolean() }) } } }, async (request) => {
    agents.getRow(requireUser(request).orgId, request.params.id);
    return { stopped: manager.stop(request.params.id) };
  });

  app.get("/:id/runs", { schema: { params: IdParams, querystring: RunsQuery, response: { 200: RunsWithActivity } } }, async (request) => {
    const user = requireUser(request);
    agents.getRow(user.orgId, request.params.id);
    const list = runs.listRuns(user.orgId, request.params.id, request.query.limit ?? 20);
    return { runs: list, activity: runs.listActivity(list.map((r) => r.id)) };
  });

  app.get("/:id/usage", { schema: { params: IdParams, response: { 200: UsageSummary } } }, async (request) => {
    const user = requireUser(request);
    agents.getRow(user.orgId, request.params.id);
    return runs.usageSummary(user.orgId, request.params.id);
  });
};
