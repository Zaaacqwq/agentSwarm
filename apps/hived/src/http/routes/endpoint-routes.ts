import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { CreateEndpoint, Endpoint, IdParams, Ok, UpdateEndpoint } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";

export const endpointRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { endpoints } = deps.services;

  app.get("/", { schema: { response: { 200: Type.Array(Endpoint) } } }, async (request) => endpoints.list(requireUser(request)));

  app.post("/", { schema: { body: CreateEndpoint, response: { 200: Endpoint } } }, async (request) =>
    endpoints.create(requireUser(request), request.body),
  );

  app.patch("/:id", { schema: { params: IdParams, body: UpdateEndpoint, response: { 200: Endpoint } } }, async (request) =>
    endpoints.update(requireUser(request), request.params.id, request.body),
  );

  app.delete("/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (request) => {
    endpoints.remove(requireUser(request), request.params.id);
    return { ok: true as const };
  });
};
