import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, harness, type Harness } from "./harness.ts";
import { schema } from "../src/db/client.ts";

describe("auth and request guards", () => {
  let h: Harness;
  before(async () => (h = await harness()));
  after(() => h.close());

  test("setup happens once; the API needs a session", async () => {
    assert.equal((await h.api("GET", "/api/me")).status, 401);
    const cookie = await h.login();
    assert.equal((await h.api("GET", "/api/me", undefined, cookie)).body.username, "admin");
    assert.equal((await h.api("POST", "/api/setup", { username: "other", password: "another long password" })).status, 409);
    assert.equal((await h.api("POST", "/api/auth/login", { ...ADMIN, password: "wrong password here" })).status, 401);
  });

  test("cross-origin and non-JSON writes are refused", async () => {
    const cookie = await h.login();
    const cross = await h.app.inject({ method: "POST", url: "/api/endpoints", headers: { cookie, origin: "http://evil.example", "content-type": "application/json" }, payload: "{}" });
    assert.equal(cross.statusCode, 403);
    const form = await h.app.inject({ method: "POST", url: "/api/endpoints", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "name=x" });
    assert.equal(form.statusCode, 415);
  });

  test("API keys and tokens are stored sealed and never returned", async () => {
    const cookie = await h.login();
    const ep = await h.api("POST", "/api/endpoints", { name: "OR", kind: "openrouter", apiKey: "sk-or-very-secret-value" }, cookie);
    assert.equal(ep.status, 200);
    assert.equal(ep.body.hasKey, true);
    assert.ok(!JSON.stringify(ep.body).includes("very-secret"));
    assert.ok(!JSON.stringify(h.db.db.select().from(schema.endpoints).all()).includes("very-secret"));
    await h.api("PUT", "/api/github", { token: "github_pat_secret_token_value_1234" }, cookie);
    assert.ok(!JSON.stringify(h.db.db.select().from(schema.githubCredentials).all()).includes("secret_token"));
    assert.ok(!JSON.stringify((await h.api("GET", "/api/github", undefined, cookie)).body).includes("secret_token"));
    assert.equal((await h.api("POST", "/api/endpoints", { name: "x", kind: "openrouter" }, cookie)).status, 400);
  });

  test("adding a project mirrors it and protects the default branch", async () => {
    const { cookie, projectId } = await h.ready();
    const project = (await h.api("GET", `/api/projects/${projectId}`, undefined, cookie)).body;
    assert.equal(project.defaultBranch, "main");
    assert.ok(project.protectedAt);
    assert.ok(h.protectedBranches.has("tester/demo:main"));
    assert.equal((await h.api("POST", "/api/projects", { githubRepo: "tester/demo" }, cookie)).status, 409);
    const ws = (await h.api("GET", "/api/workstations", undefined, cookie)).body;
    assert.deepEqual(ws.map((w: { id: string; status: string }) => `${w.id}:${w.status}`), ["ws-1:free", "ws-2:free"]);
  });
});
