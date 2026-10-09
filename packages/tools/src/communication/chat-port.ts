import type { AgentContext } from "../toolpack.ts";

export interface ChannelMessageView {
  readonly id: number;
  readonly author: string;
  readonly authorKind: "user" | "agent" | "system";
  readonly body: string;
  readonly replyToId: number | null;
  /** e.g. ["👍×2"] */
  readonly reactions: readonly string[];
  /** e.g. ["log.txt (file_ab12, 2 KB)"] */
  readonly attachments?: readonly string[];
  readonly createdAt: number;
}

export interface ChatView {
  readonly channelId: string;
  readonly kind: "dm" | "group" | "agent_dm" | "task";
  readonly title: string;
  readonly members: readonly string[];
  /** False for a person's private chat when they did not message you in this turn. */
  readonly canSend: boolean;
}

export interface ColleagueView {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

/**
 * What the communication and colleague packs need from hived. Every method checks
 * membership and publication policy itself and throws Error with a model-readable message.
 */
export interface ChatPort {
  listChats(ctx: AgentContext): ChatView[];
  send(ctx: AgentContext, input: { channelId: string; body: string; replyToId?: number }): { id: number };
  read(ctx: AgentContext, channelId: string, opts: { before?: number; limit: number }): { messages: ChannelMessageView[]; hasMore: boolean };
  searchFor(ctx: AgentContext, query: string, channelId?: string): (ChannelMessageView & { channel: string })[];
  reactAsAgent(ctx: AgentContext, messageId: number, emoji: string): void;
  directory(ctx: AgentContext): ColleagueView[];
  messageAgent(ctx: AgentContext, target: string, body: string): { channelId: string; id: number };
  readFile(ctx: AgentContext, fileId: string): { filename: string; text: string; truncated: boolean };
}
