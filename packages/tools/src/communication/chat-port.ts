export interface ChannelMessageView {
  readonly id: number;
  readonly author: string;
  readonly authorKind: "user" | "agent" | "system";
  readonly body: string;
  readonly createdAt: number;
}

/** What the communication pack needs from the chat service; hived implements it. */
export interface ChatPort {
  isMember(channelId: string, agentId: string): boolean;
  postAgentMessage(input: { channelId: string; agentId: string; runId: string; body: string }): { id: number };
  readChannel(channelId: string, opts: { before?: number; limit: number }): { messages: ChannelMessageView[]; hasMore: boolean };
}
