import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app/build-app.ts";
import { buildWorld } from "./fakes.ts";
import { localBackend } from "./local-backend.ts";

async function remoteRepo(): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-remote-")));
  const src = join(base, "src");
  mkdirSync(join(src, "lib"), { recursive: true });
  writeFileSync(join(src, "lib", "a.ts"), "export const a = 1;\n");
  const run = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd });
  run(src, "git", "init", "-q", "-b", "main");
  run(src, "git", "add", ".");
  run(src, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  run(base, "git", "clone", "-q", "--bare", src, "r.git");
  return join(base, "r.git");
}

describe("workstation API", () => {
  test("register, bind, browse files, terminals and host status", async () => {
    const w = await buildWorld({ backend: localBackend().backend });
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    const cookie = `hive_session=${w.token}`;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload ? { payload } : {}) });

    const ws = (await call("POST", "/api/workstations", { name: "Bench", osUser: "ws-1" })).json();
    expect(ws).toMatchObject({ name: "Bench", osUser: "ws-1", kind: "local-fake", writeLease: null });
    expect((await call("POST", "/api/workstations", { name: "Dup", osUser: "ws-1" })).statusCode).toBe(409);
    expect((await call("POST", "/api/workstations", { name: "Missing", osUser: "ws-9" })).statusCode).toBe(400);
    expect((await call("POST", "/api/workstations", { name: "Bad", osUser: "root" })).statusCode).toBe(400);

    const agent = w.makeAgent("Ada");
    expect((await call("PUT", `/api/agents/${agent.id}/workstation`, { workstationId: ws.id })).statusCode).toBe(200);
    expect((await call("GET", "/api/workstations")).json()[0].agentIds).toEqual([agent.id]);
    expect((await call("GET", `/api/agents/${agent.id}`)).json().workstationId).toBe(ws.id);

    await w.repos.create(w.user, { githubFullName: "zaaac/r", remoteUrl: await remoteRepo() });
    expect((await call("GET", "/api/repositories")).json().map((r: { name: string }) => r.name)).toEqual(["r"]);
    const { worktree } = await w.repos.checkout({ orgId: w.user.orgId, agent: { id: agent.id, name: "Ada" }, workstation: { id: ws.id, osUser: "ws-1" }, repoName: "r", slug: "look" });
    expect((await call("GET", `/api/workstations/${ws.id}/worktrees`)).json()).toHaveLength(1);
    const dir = (await call("GET", `/api/workstations/${ws.id}/files?worktreeId=${worktree.id}&path=lib/`)).json();
    expect(dir).toMatchObject({ kind: "dir", entries: ["lib/a.ts"] });
    const file = (await call("GET", `/api/workstations/${ws.id}/files?worktreeId=${worktree.id}&path=lib/a.ts`)).json();
    expect(file).toMatchObject({ kind: "file", content: "export const a = 1;\n" });
    expect((await call("GET", `/api/workstations/${ws.id}/files?worktreeId=${worktree.id}&path=../../ws-2`)).statusCode).toBe(400);
    expect((await call("GET", `/api/workstations/${ws.id}/files?worktreeId=wt_nope`)).statusCode).toBe(404);

    expect((await call("GET", `/api/workstations/${ws.id}/terminals`)).json() as unknown).toEqual([]);
    const host = (await call("GET", "/api/host")).json();
    expect(host).toMatchObject({ pressure: "normal", workstationsReady: true, heavyTasks: { slots: 2 } });
    expect((await call("GET", `/api/agents/${agent.id}/pushes`)).json() as unknown).toEqual([]);

    expect((await call("PUT", `/api/agents/${agent.id}/workstation`, { workstationId: null })).statusCode).toBe(200);
    expect((await call("DELETE", `/api/workstations/${ws.id}`)).statusCode).toBe(200);
    await app.close();
  });
});
