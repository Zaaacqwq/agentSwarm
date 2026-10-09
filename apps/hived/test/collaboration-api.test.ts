import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app/build-app.ts";
import { buildWorld, callTool, waitForAbort } from "./fakes.ts";

describe("collaboration API", () => {
  test("groups, replies, reactions, search and agent-DM read-only", async () => {
    let block = false;
    const w = await buildWorld({
      script: async (input) => {
        if (block) return waitForAbort(input.signal);
        if (input.agent.name === "Ada" && input.prompt.includes("(person)")) await callTool(input, "message_agent", { agent: "Bob", body: "fyi" });
      },
    });
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    const cookie = `hive_session=${w.token}`;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const ada = w.makeAgent("Ada", [{ toolpackId: "core.communication", toolName: "*" }, { toolpackId: "core.colleagues", toolName: "*" }]);
    const bob = w.makeAgent("Bob");

    const group = (await call("POST", "/api/channels/groups", { title: "Crew", agentIds: [ada.id, bob.id] })).json();
    expect(group).toMatchObject({ kind: "group", title: "Crew" });
    expect(group.members).toHaveLength(3);
    expect((await call("POST", "/api/channels/groups", { title: "Empty", agentIds: [] })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/channels/${group.id}`, { title: "Crew 2" })).json().title).toBe("Crew 2");

    const first = (await call("POST", `/api/channels/${group.id}/messages`, { body: "kick off @Ada" })).json();
    expect(first.mentions).toEqual([ada.id]);
    const reply = (await call("POST", `/api/channels/${group.id}/messages`, { body: "follow-up", replyToId: first.id })).json();
    expect(reply.replyToId).toBe(first.id);
    await w.manager.idle();

    const reacted = (await call("PUT", `/api/messages/${first.id}/reactions`, { emoji: "🎉" })).json();
    expect(reacted.reactions).toEqual([{ emoji: "🎉", actors: [{ kind: "user", id: w.user.id }] }]);
    expect((await call("DELETE", `/api/messages/${first.id}/reactions`, { emoji: "🎉" })).json().reactions).toEqual([]);
    expect((await call("PUT", `/api/messages/${first.id}/reactions`, { emoji: "lol" })).statusCode).toBe(400);

    const hits = (await call("GET", "/api/search?q=kick")).json();
    expect(hits[0]).toMatchObject({ channelKind: "group", channelTitle: "Crew 2" });

    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "tell bob");
    await w.manager.idle();
    const agentDm = (await call("GET", "/api/channels")).json().find((c: { kind: string }) => c.kind === "agent_dm");
    expect((await call("GET", `/api/channels/${agentDm.id}/messages`)).json().messages[0].body).toBe("fyi");
    expect((await call("POST", `/api/channels/${agentDm.id}/messages`, { body: "hi" })).statusCode).toBe(403);
    expect((await call("PUT", `/api/messages/${(await call("GET", `/api/channels/${agentDm.id}/messages`)).json().messages[0].id}/reactions`, { emoji: "👍" })).statusCode).toBe(403);

    block = true;
    await call("POST", `/api/channels/${group.id}/messages`, { body: "@Bob long task" });
    await Bun.sleep(10);
    expect((await call("DELETE", `/api/channels/${group.id}`)).statusCode).toBe(409);
    w.manager.stop(bob.id);
    await w.manager.idle();
    expect((await call("DELETE", `/api/channels/${group.id}`)).statusCode).toBe(200);
    expect((await call("GET", `/api/channels/${group.id}`)).statusCode).toBe(404);
    await app.close();
  });
});
