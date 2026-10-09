import { Type, type Static } from "typebox";
import { AgentState } from "./agents.ts";

export const AuthorKind = Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("system")]);
export type AuthorKind = Static<typeof AuthorKind>;

export const ChannelKind = Type.Union([Type.Literal("dm"), Type.Literal("group"), Type.Literal("agent_dm"), Type.Literal("task")]);

export const AttachmentRef = Type.Object({ id: Type.String(), filename: Type.String(), mime: Type.String(), size: Type.Number() });
export type AttachmentRef = Static<typeof AttachmentRef>;
export type ChannelKind = Static<typeof ChannelKind>;

export const Actor = Type.Object({ kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]), id: Type.String() });
export type Actor = Static<typeof Actor>;

export const ReactionSummary = Type.Object({ emoji: Type.String(), actors: Type.Array(Actor) });
export type ReactionSummary = Static<typeof ReactionSummary>;

export const Message = Type.Object({
  id: Type.Number(),
  channelId: Type.String(),
  authorKind: AuthorKind,
  authorId: Type.String(),
  authorName: Type.String(),
  body: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  replyToId: Type.Union([Type.Number(), Type.Null()]),
  chainId: Type.Union([Type.String(), Type.Null()]),
  mentions: Type.Array(Type.String()),
  reactions: Type.Array(ReactionSummary),
  attachments: Type.Array(AttachmentRef),
  createdAt: Type.Number(),
});
export type Message = Static<typeof Message>;

export const Channel = Type.Object({
  id: Type.String(),
  kind: ChannelKind,
  title: Type.Union([Type.String(), Type.Null()]),
  members: Type.Array(Actor),
  /** dm only: the agent on the other side (kept for P1 clients). */
  agentId: Type.Union([Type.String(), Type.Null()]),
  lastMessage: Type.Union([Message, Type.Null()]),
  /** dm only: that agent's state. */
  agentState: AgentState,
  createdAt: Type.Number(),
});
export type Channel = Static<typeof Channel>;

export const OpenDm = Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

const GroupTitle = Type.String({ minLength: 1, maxLength: 60 });
const GroupAgents = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 });

export const CreateGroup = Type.Object({ title: GroupTitle, agentIds: GroupAgents }, { additionalProperties: false });
export type CreateGroup = Static<typeof CreateGroup>;

export const UpdateGroup = Type.Object({ title: Type.Optional(GroupTitle), agentIds: Type.Optional(GroupAgents) }, { additionalProperties: false });
export type UpdateGroup = Static<typeof UpdateGroup>;

export const PostMessage = Type.Object(
  {
    body: Type.String({ minLength: 1, maxLength: 20000 }),
    replyToId: Type.Optional(Type.Integer({ minimum: 1 })),
    attachmentIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
  },
  { additionalProperties: false },
);
export type PostMessage = Static<typeof PostMessage>;

export const ReactBody = Type.Object({ emoji: Type.String({ minLength: 1, maxLength: 32 }) }, { additionalProperties: false });

export const MessagePage = Type.Object({
  messages: Type.Array(Message),
  hasMore: Type.Boolean(),
});
export type MessagePage = Static<typeof MessagePage>;

export const MessagePageQuery = Type.Object({
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  around: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export type MessagePageQuery = Static<typeof MessagePageQuery>;

export const SearchQuery = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  channelId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export type SearchQuery = Static<typeof SearchQuery>;

export const SearchHit = Type.Object({
  message: Message,
  channelKind: ChannelKind,
  channelTitle: Type.String(),
});
export type SearchHit = Static<typeof SearchHit>;

export const QueueInfo = Type.Object({
  position: Type.Number(),
  waitingFor: Type.Union([Type.String(), Type.Null()]),
});
export type QueueInfo = Static<typeof QueueInfo>;
