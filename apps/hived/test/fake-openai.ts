/** A tiny OpenAI-compatible chat completions server for exercising the real Pi pipeline offline. */
export interface RecordedRequest {
  readonly authorization: string | null;
  readonly body: {
    model: string;
    messages: { role: string; content: unknown; tool_calls?: unknown[] }[];
    tools?: { function: { name: string } }[];
  };
}

export type Reply =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "error"; status: number };

export function startFakeOpenAI(decide: (req: RecordedRequest, index: number) => Reply, port = 0) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const recorded: RecordedRequest = { authorization: request.headers.get("authorization"), body: (await request.json()) as RecordedRequest["body"] };
      requests.push(recorded);
      const reply = decide(recorded, requests.length - 1);
      if (reply.kind === "error") return Response.json({ error: { message: "upstream exploded" } }, { status: reply.status });
      return new Response(sse(recorded.body.model, reply), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

function sse(model: string, reply: Exclude<Reply, { kind: "error" }>): string {
  const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model };
  const chunks: unknown[] = [];
  if (reply.kind === "tool") {
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 } });
  } else {
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 140, completion_tokens: 5, total_tokens: 145 } });
  }
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}
