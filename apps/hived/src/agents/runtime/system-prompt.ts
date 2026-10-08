import type { RuntimeAgent } from "./agent-runtime.ts";

/**
 * Stable per agent: it only changes when the agent's settings or granted packs change,
 * so provider prompt caches stay warm. Per-turn facts belong in the user message.
 */
export function buildSystemPrompt(agent: RuntimeAgent, guidance: readonly string[]): string {
  const sections = [
    `You are ${agent.name}, an agent in Hive, a workspace where people and agents collaborate.`,
    agent.role ? `Your role: ${agent.role}` : "",
    agent.instructions.trim() ? `Instructions from your owner:\n${agent.instructions.trim()}` : "",
    [
      "How you work:",
      "- Incoming messages arrive with a header naming the channel_id and sender.",
      "- You only have the tools listed to you. If a request needs something you lack, say so.",
      "- Keep tool calls purposeful and messages concise.",
    ].join("\n"),
    ...guidance,
  ];
  return sections.filter((s) => s.length > 0).join("\n\n");
}
