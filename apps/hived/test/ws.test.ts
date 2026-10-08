import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import type { ServerEvent } from "@hive/core";
import { buildApp } from "../src/app/build-app.ts";
import { buildWorld, callTool, channelOf } from "./fakes.ts";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function connect(url: string, cookie?: string): Promise<{ ws: WebSocket; events: ServerEvent[]; closed: Promise<number> }> {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  const events: ServerEvent[] = [];
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, events, closed });
    ws.onerror = () => resolve({ ws, events, closed });
    setTimeout(() => reject(new Error("ws timeout")), 2000);
  });
}

describe("WebSocket events", () => {
  test("streams message, run, activity and state events to the logged-in org", async () => {
    const w = await buildWorld({
      script: async (input) => {
        await callTool(input, "send_message", { channel_id: channelOf(input), body: "live" });
      },
    });
    app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;

    const anon = await connect(`ws://127.0.0.1:${port}/api/ws`);
    expect(anon.ws.readyState).not.toBe(WebSocket.OPEN);

    const { ws, events } = await connect(`ws://127.0.0.1:${port}/api/ws`, `hive_session=${w.token}`);
    const agent = w.makeAgent("Ada");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "hello");
    await w.manager.idle();
    await Bun.sleep(50);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["message.created", "run.updated", "activity.created", "agent.state"]) expect(types.has(t as ServerEvent["type"])).toBe(true);
    const bodies = events.flatMap((e) => (e.type === "message.created" ? [e.message.body] : []));
    expect(bodies).toEqual(["hello", "live"]);
    ws.close();
  });
});
