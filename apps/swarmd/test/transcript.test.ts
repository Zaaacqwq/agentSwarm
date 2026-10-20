import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dropBrokenToolCalls } from "../src/agents/transcript.ts";

const msg = (m: object) => m as AgentMessage;

test("a tool call a model sent with no name or id, and its result, are left out; everything else stays", () => {
  const messages = [
    msg({ role: "user", content: [{ type: "text", text: "Look back." }] }),
    msg({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "recall", arguments: {} }, { type: "toolCall", id: "", name: "", arguments: {} }] }),
    msg({ role: "toolResult", toolCallId: "call_1", toolName: "recall", content: [{ type: "text", text: "No lessons." }], isError: false }),
    msg({ role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true }),
    msg({ role: "assistant", content: [{ type: "toolCall", id: "", name: "", arguments: {} }] }),
    msg({ role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true }),
    msg({ role: "user", content: [{ type: "text", text: "continue" }] }),
  ];
  const out = dropBrokenToolCalls(messages) as unknown as { role: string; content: { type: string; id?: string; text?: string }[]; toolCallId?: string }[];
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "toolResult", "assistant", "user"]);
  assert.deepEqual(out[1]!.content.map((c) => c.id), ["call_1"]);
  assert.equal(out[2]!.toolCallId, "call_1");
  assert.match(out[3]!.content[0]!.text!, /malformed tool call/);
  // Nothing broken: the same messages.
  const fine = messages.slice(0, 1);
  assert.deepEqual(dropBrokenToolCalls(fine), fine);
});
