import { describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app/build-app.ts";
import { SecretBox } from "../src/crypto/secret-box.ts";
import { createServices } from "../src/app/services.ts";
import { schema } from "../src/db/client.ts";
import { ADMIN, memoryDb } from "./helpers.ts";
import { callTool, channelOf, ScriptedRuntime } from "./fakes.ts";

const OPENROUTER_KEY = "sk-or-v1-supersecretvalue";

async function setup() {
  const handle = memoryDb();
  const runtime = new ScriptedRuntime(async (input) => {
    await callTool(input, "send_message", { channel_id: channelOf(input), body: "hi from agent" });
  });
  const services = createServices({ db: handle.db, secrets: await SecretBox.fromRawKey(new Uint8Array(32)), runtime, log: () => {} });
  await services.start();
  const app = await buildApp({ services, config: { secureCookies: false, webDistDir: null } });
  return { app, services, handle };
}

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: ADMIN });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "hive_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  return `hive_session=${cookie!.value}`;
}

describe("HTTP API", () => {
  test("everything but auth requires a session", async () => {
    const { app } = await setup();
    for (const url of ["/api/agents", "/api/endpoints", "/api/channels", "/api/toolpacks", "/api/usage", "/api/openapi.json"]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
    const session = await app.inject({ url: "/api/auth/session" });
    expect(session.json() as unknown).toEqual({ setupRequired: true, user: null });
  });

  test("setup works once; login and logout manage the cookie", async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const again = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "evil", password: "another long password" } });
    expect(again.statusCode).toBe(409);
    expect((await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().user.username).toBe("admin");

    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "not the password" } });
    expect(bad.statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/agents", headers: { cookie } })).statusCode).toBe(401);
  });

  test("short passwords and junk bodies are rejected", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "admin", password: "short" } });
    expect(res.statusCode).toBe(400);
  });

  test("login is rate limited", async () => {
    const { app } = await setup();
    await login(app);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong password!!" } })).statusCode;
    }
    expect(last).toBe(429);
  });

  test("cross-origin writes are refused", async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const res = await app.inject({
      method: "POST", url: "/api/endpoints", headers: { cookie, origin: "https://evil.example", host: "127.0.0.1:4318" },
      payload: { name: "x", kind: "openrouter", apiKey: OPENROUTER_KEY },
    });
    expect(res.statusCode).toBe(403);
  });

  test("endpoint keys never appear in responses, logs, or audit rows", async () => {
    const { app, handle } = await setup();
    const cookie = await login(app);
    const created = await app.inject({ method: "POST", url: "/api/endpoints", headers: { cookie }, payload: { name: "OR", kind: "openrouter", apiKey: OPENROUTER_KEY } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", hasApiKey: true });
    const list = await app.inject({ url: "/api/endpoints", headers: { cookie } });
    const patched = await app.inject({ method: "PATCH", url: `/api/endpoints/${created.json().id}`, headers: { cookie }, payload: { apiKey: `${OPENROUTER_KEY}-2` } });
    for (const body of [created.body, list.body, patched.body]) expect(body).not.toContain("supersecret");
    const stored = JSON.stringify(handle.db.select().from(schema.endpoints).all()) + JSON.stringify(handle.db.select().from(schema.auditLogs).all());
    expect(stored).not.toContain("supersecret");
    const compat = await app.inject({ method: "POST", url: "/api/endpoints", headers: { cookie }, payload: { name: "Local", kind: "openai-compatible", apiKey: "local-key-123" } });
    expect(compat.statusCode).toBe(400);
  });

  test("agent CRUD, DM chat, runs and usage over HTTP", async () => {
    const { app, services } = await setup();
    const cookie = await login(app);
    const ep = (await app.inject({ method: "POST", url: "/api/endpoints", headers: { cookie }, payload: { name: "OR", kind: "openrouter", apiKey: OPENROUTER_KEY } })).json();
    const packs = (await app.inject({ url: "/api/toolpacks", headers: { cookie } })).json();
    expect(packs[0]).toMatchObject({ id: "core.communication", available: true });

    const payload = { name: "Ada", role: "dev", instructions: "", endpointId: ep.id, modelId: "openai/gpt-5-mini", thinkingLevel: "low", grants: [{ toolpackId: "core.communication", toolName: "*" }] };
    const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload })).json();
    expect(agent).toMatchObject({ name: "Ada", state: "idle", grants: [{ toolpackId: "core.communication", toolName: "*" }] });
    expect((await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload })).statusCode).toBe(409);
    const badGrant = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { ...payload, name: "Eve", grants: [{ toolpackId: "root.shell", toolName: "*" }] } });
    expect(badGrant.statusCode).toBe(400);

    const dm = (await app.inject({ method: "POST", url: "/api/channels/dm", headers: { cookie }, payload: { agentId: agent.id } })).json();
    const sameDm = (await app.inject({ method: "POST", url: "/api/channels/dm", headers: { cookie }, payload: { agentId: agent.id } })).json();
    expect(sameDm.id).toBe(dm.id);
    const posted = await app.inject({ method: "POST", url: `/api/channels/${dm.id}/messages`, headers: { cookie }, payload: { body: "hello" } });
    expect(posted.statusCode).toBe(200);
    await services.manager.idle();

    const page = (await app.inject({ url: `/api/channels/${dm.id}/messages`, headers: { cookie } })).json();
    expect(page.messages.map((m: { body: string }) => m.body)).toEqual(["hello", "hi from agent"]);
    const runs = (await app.inject({ url: `/api/agents/${agent.id}/runs`, headers: { cookie } })).json();
    expect(runs.runs[0].status).toBe("succeeded");
    expect(runs.activity.length).toBeGreaterThan(0);
    expect((await app.inject({ url: "/api/channels", headers: { cookie } })).json()[0].lastMessage.body).toBe("hi from agent");
    expect((await app.inject({ url: `/api/agents/${agent.id}/usage`, headers: { cookie } })).statusCode).toBe(200);

    const renamed = await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, headers: { cookie }, payload: { name: "Ada Two" } });
    expect(renamed.json().name).toBe("Ada Two");
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/stop`, headers: { cookie } })).json() as unknown).toEqual({ stopped: false });
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/channels/${dm.id}/messages`, headers: { cookie } })).statusCode).toBe(404);
  });

  test("OpenAPI document is generated from the same contracts", async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const doc = (await app.inject({ url: "/api/openapi.json", headers: { cookie } })).json();
    expect(Object.keys(doc.paths)).toContain("/api/agents/");
    expect(Object.keys(doc.paths)).toContain("/api/channels/{id}/messages");
  });

  test("foreign origins and hosts are refused, including reads", async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const read = await app.inject({ url: "/api/channels", headers: { cookie, origin: "http://localhost:5174", host: "localhost:4318" } });
    expect(read.statusCode).toBe(403);
    const rebind = await app.inject({ url: "/api/auth/session", headers: { host: "evil.example:4318" } });
    expect(rebind.statusCode).toBe(403);
    const same = await app.inject({ url: "/api/channels", headers: { cookie, origin: "http://localhost:4318", host: "localhost:4318" } });
    expect(same.statusCode).toBe(200);
  });
});
