import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { Channel, IdParams, Message, MessagePage, MessagePageQuery, OpenDm, PostMessage } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";

export const chatRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { chat } = deps.services;

  app.get("/", { schema: { response: { 200: Type.Array(Channel) } } }, async (request) => chat.listChannels(requireUser(request)));

  app.post("/dm", { schema: { body: OpenDm, response: { 200: Channel } } }, async (request) =>
    chat.openDm(requireUser(request), request.body.agentId),
  );

  app.get("/:id/messages", { schema: { params: IdParams, querystring: MessagePageQuery, response: { 200: MessagePage } } }, async (request) =>
    chat.listMessages(requireUser(request), request.params.id, request.query),
  );

  app.post("/:id/messages", { schema: { params: IdParams, body: PostMessage, response: { 200: Message } } }, async (request) =>
    chat.postUserMessage(requireUser(request), request.params.id, request.body.body.trim() || request.body.body),
  );
};
