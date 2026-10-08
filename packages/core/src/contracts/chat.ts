import { Type, type Static } from "typebox";
import { AgentState } from "./agents.ts";

export const AuthorKind = Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("system")]);
export type AuthorKind = Static<typeof AuthorKind>;

export const Message = Type.Object({
  id: Type.Number(),
  channelId: Type.String(),
  authorKind: AuthorKind,
  authorId: Type.String(),
  body: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
});
export type Message = Static<typeof Message>;

export const Channel = Type.Object({
  id: Type.String(),
  kind: Type.Literal("dm"),
  agentId: Type.String(),
  lastMessage: Type.Union([Message, Type.Null()]),
  agentState: AgentState,
  createdAt: Type.Number(),
});
export type Channel = Static<typeof Channel>;

export const OpenDm = Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export const PostMessage = Type.Object(
  { body: Type.String({ minLength: 1, maxLength: 20000 }) },
  { additionalProperties: false },
);
export type PostMessage = Static<typeof PostMessage>;

export const MessagePage = Type.Object({
  messages: Type.Array(Message),
  hasMore: Type.Boolean(),
});
export type MessagePage = Static<typeof MessagePage>;

export const MessagePageQuery = Type.Object({
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export type MessagePageQuery = Static<typeof MessagePageQuery>;
