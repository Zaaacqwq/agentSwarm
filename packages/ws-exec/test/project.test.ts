import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dispatch } from "../src/dispatch.ts";
import { denyPortsFile } from "../src/sandbox.ts";
import type { Request } from "../src/protocol.ts";
import { fixture } from "./fixture.ts";

async function call<T = Record<string, unknown>>(env: Parameters<typeof dispatch>[0], request: Request): Promise<T> {
  const res = await dispatch(env, request);
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.result as T;
}

const SCOPE = "worktrees/demo/t1--part";
const clone = (files?: { path: string; content: string }[]): Request => ({ op: "git.clone", scope: SCOPE, mirror: "demo.git", branch: "swarm/demo/t1/part", base: "main", ...(files ? { files } : {}) });

describe("project files and machine limits (sandboxed)", () => {
  test("local files land in the worktree, stay out of commits, and are refreshed on a resumed clone", async () => {
    const f = fixture(true);
    try {
      const res = await call<{ files: number }>(f.env, clone([{ path: "Local.xcconfig", content: "API_KEY = dev\n" }, { path: "App/Secrets.plist", content: "<plist/>" }]));
      assert.equal(res.files, 2);
      const dir = join(f.env.root, SCOPE);
      assert.equal(readFileSync(join(dir, "Local.xcconfig"), "utf8"), "API_KEY = dev\n");
      assert.match(readFileSync(join(dir, ".git/info/exclude"), "utf8"), /^\/Local\.xcconfig$/m);
      // An agent's `git add -A` does not pick them up.
      await call(f.env, { op: "fs.write", scope: SCOPE, path: "feature.txt", content: "x\n" });
      await call(f.env, { op: "git.commit", scope: SCOPE, message: "work" });
      const files = await call<{ output: string }>(f.env, { op: "exec", scope: SCOPE, command: "git show --name-only --format= HEAD" });
      assert.equal(files.output.trim(), "feature.txt");
      const again = await call<{ resumed: boolean; files: number }>(f.env, clone([{ path: "Local.xcconfig", content: "API_KEY = new\n" }]));
      assert.equal(again.resumed, true);
      assert.equal(readFileSync(join(dir, "Local.xcconfig"), "utf8"), "API_KEY = new\n");
      for (const bad of ["../escape", ".git/config", "/etc/hosts", "a/../../b"]) {
        await assert.rejects(call(f.env, clone([{ path: bad, content: "x" }])), { code: "bad_request" }, bad);
      }
    } finally {
      f.cleanup();
    }
  });

  test("ports on the deny list cannot be reached from a command; others can", async () => {
    const f = fixture(true);
    const server = createServer((s) => {
      s.on("error", () => undefined);
      s.end("hi\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      mkdirSync(join(f.env.root, "work"));
      const reach = async () => (await call<{ exitCode: number }>(f.env, { op: "exec", scope: "work", command: `/usr/bin/nc -z -w 3 127.0.0.1 ${port}` })).exitCode;
      assert.equal(await reach(), 0, "allowed before it is listed");
      mkdirSync(dirname(denyPortsFile(f.env)), { recursive: true });
      writeFileSync(denyPortsFile(f.env), JSON.stringify([port, "junk", 99999]));
      assert.notEqual(await reach(), 0, "denied once listed");
      writeFileSync(denyPortsFile(f.env), "not json");
      assert.equal(await reach(), 0, "a broken list denies nothing extra");
    } finally {
      server.close();
      f.cleanup();
    }
  });
});
