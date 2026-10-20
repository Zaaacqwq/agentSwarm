import type { AgentMessage } from "@earendil-works/pi-agent-core";

const DROPPED = "[A malformed tool call (no name or id) was left out here; call the tool again if you need it.]";

type Part = { type?: string; id?: unknown; name?: unknown };

const broken = (c: Part) => c.type === "toolCall" && (typeof c.id !== "string" || !c.id || typeof c.name !== "string" || !c.name);

/**
 * A copy of the messages without tool calls a model sent with no name or id, and without the results of those calls.
 * Providers refuse every later request that still carries one ("tool messages must include a non-empty tool_call_id"),
 * so one bad reply would otherwise stop the agent for good. Used before every model request and when the session is
 * saved.
 */
export function dropBrokenToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
  if (!messages.some((m) => isBroken(m))) return [...messages];
  return messages.flatMap((m): AgentMessage[] => {
    const role = (m as { role?: string }).role;
    if (role === "toolResult") {
      const id = (m as { toolCallId?: unknown }).toolCallId;
      return typeof id === "string" && id ? [m] : [];
    }
    const content = (m as { content?: unknown }).content;
    if (role !== "assistant" || !Array.isArray(content) || !content.some((c) => broken(c as Part))) return [m];
    const kept = content.filter((c) => !broken(c as Part));
    return [{ ...m, content: kept.length ? kept : [{ type: "text", text: DROPPED }] } as AgentMessage];
  });
}

function isBroken(m: AgentMessage): boolean {
  const role = (m as { role?: string }).role;
  if (role === "toolResult") {
    const id = (m as { toolCallId?: unknown }).toolCallId;
    return typeof id !== "string" || !id;
  }
  const content = (m as { content?: unknown }).content;
  return role === "assistant" && Array.isArray(content) && content.some((c) => broken(c as Part));
}
