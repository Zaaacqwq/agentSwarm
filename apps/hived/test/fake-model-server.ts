// Manual demo helper: a fake OpenAI-compatible model that answers via send_message.
// Usage: bun apps/hived/test/fake-model-server.ts <port>
import { startFakeOpenAI, type RecordedRequest } from "./fake-openai.ts";

function lastUserText(req: RecordedRequest): string {
  const user = [...req.body.messages].reverse().find((m) => m.role === "user");
  if (typeof user?.content === "string") return user.content;
  const parts = Array.isArray(user?.content) ? (user.content as { type: string; text?: string }[]) : [];
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

const port = Number(process.argv[2] ?? "4390");
const fake = startFakeOpenAI((req) => {
  if (req.body.messages.at(-1)?.role === "tool") return { kind: "text", text: "Replied via send_message." };
  const text = lastUserText(req);
  const channel = /channel_id=(ch_[a-z0-9]+)/.exec(text)?.[1];
  if (!channel) return { kind: "text", text: "no channel" };
  // Stay quiet when only another agent spoke, so fake agents never ping-pong.
  if (!text.includes("(person):")) return { kind: "text", text: "Noted; nothing to add." };
  const said = text.split("(person): ").slice(1).join("(person): ");
  const relay = /relay to (\w+)/i.exec(said)?.[1];
  if (relay) return { kind: "tool", name: "message_agent", args: { agent: relay, body: "relayed from the owner" } };
  return {
    kind: "tool",
    name: "send_message",
    args: { channel_id: channel, body: `Got it. You said **${said}**.\n\n- I run on a *fake* model\n- Tools: \`send_message\`, \`read_channel\`` },
  };
}, port);
process.stderr.write(`fake model on ${fake.url}\n`);
