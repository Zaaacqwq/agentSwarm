import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { BindWorkstation, CreateRepository, CreateWorkstation, GitPush, HostStatus, IdParams, Ok, Repository, Terminal, Workstation, Worktree } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import { WorkstationError } from "../../workstations/backend.ts";

const TerminalParams = Type.Object({ id: Type.String(), name: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }) });
const FileQuery = Type.Object({ worktreeId: Type.String(), path: Type.Optional(Type.String({ maxLength: 1024 })) });

/** Read-only views of workstations for the UI, plus admin actions. Agents use tools, not these routes. */
export const workstationRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { workstations, repos, bus, host } = deps.services;

  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WorkstationError) throw badRequest(error.message);
      throw error;
    }
  };

  app.get("/workstations", { schema: { response: { 200: Type.Array(Workstation) } } }, async (req) => workstations.list(requireUser(req).orgId));

  app.post("/workstations", { schema: { body: CreateWorkstation, response: { 200: Workstation } } }, async (req) => {
    const user = requireUser(req);
    const ws = await workstations.create(user, req.body);
    bus.publish(user.orgId, { type: "workstation.updated", workstation: ws });
    return ws;
  });

  app.delete("/workstations/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    workstations.remove(requireUser(req), req.params.id);
    return { ok: true as const };
  });

  app.get("/workstations/:id/worktrees", { schema: { params: IdParams, response: { 200: Type.Array(Worktree) } } }, async (req) => {
    workstations.getRow(requireUser(req).orgId, req.params.id);
    return repos.worktreesFor({ workstationId: req.params.id });
  });

  app.get("/workstations/:id/terminals", { schema: { params: IdParams, response: { 200: Type.Array(Terminal) } } }, async (req) =>
    wrap(() => workstations.terminals(workstations.getRow(requireUser(req).orgId, req.params.id))),
  );

  app.get("/workstations/:id/terminals/:name", { schema: { params: TerminalParams, response: { 200: Type.Object({ output: Type.String() }) } } }, async (req) =>
    wrap(async () => ({ output: await workstations.readTerminal(workstations.getRow(requireUser(req).orgId, req.params.id), req.params.name) })),
  );

  app.get("/workstations/:id/files", { schema: { params: IdParams, querystring: FileQuery } }, async (req) => {
    const ws = workstations.getRow(requireUser(req).orgId, req.params.id);
    const wt = repos.worktree(req.query.worktreeId);
    if (!wt || wt.removedAt || wt.workstationId !== ws.id) throw notFound("Worktree");
    const path = req.query.path ?? ".";
    return wrap(async () => {
      if (path === "." || path.endsWith("/")) {
        return { kind: "dir", ...(await workstations.backend.call<object>(ws.osUser, { op: "fs.list", scope: wt.scope, path, depth: 1 })) };
      }
      return { kind: "file", ...(await workstations.backend.call<object>(ws.osUser, { op: "fs.read", scope: wt.scope, path, limit: 2000 })) };
    });
  });

  app.put("/agents/:id/workstation", { schema: { params: IdParams, body: BindWorkstation, response: { 200: Ok } } }, async (req) => {
    const user = requireUser(req);
    deps.services.agents.getRow(user.orgId, req.params.id);
    workstations.bind(user, req.params.id, req.body.workstationId);
    bus.publish(user.orgId, { type: "agent.updated", agent: deps.services.agents.get(user, req.params.id) });
    for (const ws of workstations.list(user.orgId)) bus.publish(user.orgId, { type: "workstation.updated", workstation: ws });
    return { ok: true as const };
  });

  app.get("/agents/:id/pushes", { schema: { params: IdParams, response: { 200: Type.Array(GitPush) } } }, async (req) => {
    deps.services.agents.getRow(requireUser(req).orgId, req.params.id);
    return deps.services.relay.history(req.params.id);
  });

  app.get("/repositories", { schema: { response: { 200: Type.Array(Repository) } } }, async (req) => repos.list(requireUser(req).orgId));

  app.post("/repositories", { schema: { body: CreateRepository, response: { 200: Repository } } }, async (req) =>
    repos.create(requireUser(req), req.body),
  );

  app.post("/repositories/:id/refresh", { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    await repos.refresh(repos.get(requireUser(req).orgId, req.params.id));
    return { ok: true as const };
  });

  app.delete("/repositories/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    repos.remove(requireUser(req), req.params.id);
    return { ok: true as const };
  });

  app.get("/host", { schema: { response: { 200: HostStatus } } }, async (req) => {
    requireUser(req);
    return host.current() ?? (await host.sample());
  });
};
