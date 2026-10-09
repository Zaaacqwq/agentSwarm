import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { Channel, CreateGroup, IdParams, Message, MessagePage, MessagePageQuery, Ok, OpenDm, PostMessage, ReactBody, SearchHit, SearchQuery, UpdateGroup } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";

const MessageParams = Type.Object({ id: Type.Integer({ minimum: 1 }) });

export const chatRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { chat, runs } = deps.services;

  app.get("/", { schema: { response: { 200: Type.Array(Channel) } } }, async (request) => chat.listChannels(requireUser(request)));

  app.post("/dm", { schema: { body: OpenDm, response: { 200: Channel } } }, async (request) =>
    chat.openDm(requireUser(request), request.body.agentId),
  );

  app.post("/groups", { schema: { body: CreateGroup, response: { 200: Channel } } }, async (request) =>
    chat.createGroup(requireUser(request), request.body.title, request.body.agentIds),
  );

  app.get("/:id", { schema: { params: IdParams, response: { 200: Channel } } }, async (request) => chat.channel(requireUser(request), request.params.id));

  app.patch("/:id", { schema: { params: IdParams, body: UpdateGroup, response: { 200: Channel } } }, async (request) =>
    chat.updateGroup(requireUser(request), request.params.id, request.body),
  );

  app.delete("/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (request) => {
    chat.deleteGroup(requireUser(request), request.params.id, (channelId) => runs.hasPendingWorkIn(channelId));
    return { ok: true as const };
  });

  app.get("/:id/messages", { schema: { params: IdParams, querystring: MessagePageQuery, response: { 200: MessagePage } } }, async (request) =>
    chat.listMessages(requireUser(request), request.params.id, request.query),
  );

  app.post("/:id/messages", { schema: { params: IdParams, body: PostMessage, response: { 200: Message } } }, async (request) =>
    chat.postUserMessage(requireUser(request), request.params.id, request.body.body.trim() || request.body.body, request.body.replyToId),
  );
};

export const messageRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { chat } = deps.services;

  app.put("/messages/:id/reactions", { schema: { params: MessageParams, body: ReactBody, response: { 200: Message } } }, async (request) =>
    chat.reactAsUser(requireUser(request), request.params.id, request.body.emoji, true),
  );

  app.delete("/messages/:id/reactions", { schema: { params: MessageParams, body: ReactBody, response: { 200: Message } } }, async (request) =>
    chat.reactAsUser(requireUser(request), request.params.id, request.body.emoji, false),
  );

  app.get("/search", { schema: { querystring: SearchQuery, response: { 200: Type.Array(SearchHit) } } }, async (request) =>
    chat.searchForUser(requireUser(request), request.query.q, request.query.channelId, request.query.limit),
  );
};
