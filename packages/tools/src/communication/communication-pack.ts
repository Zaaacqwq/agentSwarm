import { Type } from "typebox";
import { defineHiveTool, type AnyHiveTool, type Toolpack } from "../toolpack.ts";
import type { ChatPort } from "./chat-port.ts";

export const COMMUNICATION_PACK_ID = "core.communication";
const READ_LIMIT_MAX = 50;
const BODY_MAX = 8000;

const GUIDANCE = [
  "Communication: your replies are private until you call send_message.",
  "Plain assistant text is never shown in chat; only send_message publishes.",
  "Reply in the channel the request came from, using its channel_id.",
  "Send one substantive message per request; do not send empty acknowledgements.",
].join("\n");

export function createCommunicationPack(chat: ChatPort): Toolpack {
  const sendMessage = defineHiveTool({
    name: "send_message",
    label: "Send message",
    access: "w",
    description: "Post a Markdown message to a channel you belong to. This is the only way to reply in chat.",
    parameters: Type.Object({
      channel_id: Type.String({ description: "Target channel id from the incoming message header." }),
      body: Type.String({ minLength: 1, maxLength: BODY_MAX, description: "Markdown message text." }),
    }),
    async execute(ctx, params) {
      if (!chat.isMember(params.channel_id, ctx.agentId)) {
        return { text: `You are not a member of channel ${params.channel_id}.`, isError: true };
      }
      const body = params.body.trim();
      if (body.length === 0) return { text: "Message body is empty.", isError: true };
      const { id } = chat.postAgentMessage({ channelId: params.channel_id, agentId: ctx.agentId, runId: ctx.runId, body });
      return { text: `Sent message ${id}.`, details: { messageId: id, channelId: params.channel_id } };
    },
  });

  const readChannel = defineHiveTool({
    name: "read_channel",
    label: "Read channel",
    access: "r",
    description: "Read recent messages from a channel you belong to, newest last. Page backwards with before=<oldest id>.",
    parameters: Type.Object({
      channel_id: Type.String(),
      before: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_LIMIT_MAX })),
    }),
    async execute(ctx, params) {
      if (!chat.isMember(params.channel_id, ctx.agentId)) {
        return { text: `You are not a member of channel ${params.channel_id}.`, isError: true };
      }
      const page = chat.readChannel(params.channel_id, {
        ...(params.before !== undefined ? { before: params.before } : {}),
        limit: params.limit ?? 20,
      });
      if (page.messages.length === 0) return { text: "No messages." };
      const lines = page.messages.map((m) => `#${m.id} ${m.author}: ${truncate(m.body, 1000)}`);
      const more = page.hasMore ? `\n(older messages exist; use before=${page.messages[0]!.id})` : "";
      return { text: lines.join("\n") + more, details: { count: page.messages.length } };
    },
  });

  const tools: readonly AnyHiveTool[] = [sendMessage, readChannel];
  return {
    id: COMMUNICATION_PACK_ID,
    label: "Communication",
    tools: () => tools,
    healthcheck: async () => ({ available: true }),
    guidance: GUIDANCE,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}
