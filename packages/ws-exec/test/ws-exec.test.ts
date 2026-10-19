import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";
import { parsePasswdLine } from "../src/passwd.ts";
import { sandboxProfile } from "../src/sandbox.ts";
import { BRANCH_PATTERN } from "../src/ops/git.ts";
import type { Request } from "../src/protocol.ts";
import { fixture } from "./fixture.ts";

async function call<T = Record<string, unknown>>(env: Parameters<typeof dispatch>[0], request: Request): Promise<T> {
  const res = await dispatch(env, request);
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.result as T;
}

describe("paths", () => {
  test("rejects traversal, absolute paths and symlink escapes", async () => {
    const f = fixture(false);
    try {
      mkdirSync(join(f.env.root, "work"));
      symlinkSync(f.other, join(f.env.root, "work", "link"));
      await assert.rejects(call(f.env, { op: "fs.read", scope: "work", path: "../../ws-2/secret.txt" }), { code: "out_of_scope" });
      await assert.rejects(call(f.env, { op: "fs.read", scope: "work", path: "/etc/hosts" }), { code: "out_of_scope" });
      await assert.rejects(call(f.env, { op: "fs.read", scope: "work", path: "link/secret.txt" }), { code: "out_of_scope" });
      await assert.rejects(call(f.env, { op: "fs.list", scope: "../ws-2", path: "." }), { code: "bad_request" });
    } finally {
      f.cleanup();
    }
  });
});

describe("files", () => {
  test("write, read, edit, list and grep inside a scope", async () => {
    const f = fixture(false);
    try {
      mkdirSync(join(f.env.root, "work"));
      await call(f.env, { op: "fs.write", scope: "work", path: "src/a.txt", content: "one\ntwo\nthree\n" });
      const read = await call<{ content: string; totalLines: number }>(f.env, { op: "fs.read", scope: "work", path: "src/a.txt", offset: 2, limit: 1 });
      assert.equal(read.content, "two");
      await call(f.env, { op: "fs.edit", scope: "work", path: "src/a.txt", oldText: "two", newText: "2" });
      assert.equal(readFileSync(join(f.env.root, "work/src/a.txt"), "utf8"), "one\n2\nthree\n");
      await assert.rejects(call(f.env, { op: "fs.edit", scope: "work", path: "src/a.txt", oldText: "missing", newText: "x" }), { code: "not_found" });
      const list = await call<{ entries: string[] }>(f.env, { op: "fs.list", scope: "work", path: "." });
      assert.deepEqual(list.entries, ["src/", "src/a.txt"]);
      const grep = await call<{ matches: string[] }>(f.env, { op: "fs.grep", scope: "work", pattern: "thr" });
      assert.deepEqual(grep.matches, ["src/a.txt:3:three"]);
    } finally {
      f.cleanup();
    }
  });

  test("refuses to write inside .git", async () => {
    const f = fixture(false);
    try {
      mkdirSync(join(f.env.root, "work/.git"), { recursive: true });
      await assert.rejects(call(f.env, { op: "fs.write", scope: "work", path: ".git/config", content: "x" }), { code: "out_of_scope" });
    } finally {
      f.cleanup();
    }
  });
});

describe("commands (sandboxed)", () => {
  test("run in the scope with a clean environment", async () => {
    const f = fixture();
    process.env.SWARM_TEST_SECRET = "leak-me";
    try {
      mkdirSync(join(f.env.root, "work"));
      const r = await call<{ exitCode: number; output: string }>(f.env, { op: "exec", scope: "work", command: "pwd; echo \"secret=${SWARM_TEST_SECRET:-none}\"; echo $HOME" });
      assert.equal(r.exitCode, 0);
      assert.match(r.output, /\/ws\/ws-1\/work\n/);
      assert.match(r.output, /secret=none/);
      assert.match(r.output, new RegExp(`${f.env.home}\\n`));
    } finally {
      delete process.env.SWARM_TEST_SECRET;
      f.cleanup();
    }
  });

  test("cannot read another workstation, swarmd data or the user's home", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.env.root, "work"));
      for (const target of [join(f.other, "secret.txt"), join(f.layout.swarmdData, "master.key"), join(process.env.HOME ?? "/Users/nobody", ".zshrc")]) {
        const r = await call<{ exitCode: number; output: string }>(f.env, { op: "exec", scope: "work", command: `cat ${JSON.stringify(target)}` });
        assert.notEqual(r.exitCode, 0, `read ${target}`);
        assert.match(r.output, /Operation not permitted|No such file/);
      }
      const own = await call<{ exitCode: number }>(f.env, { op: "exec", scope: "work", command: "echo hi > note.txt && cat note.txt" });
      assert.equal(own.exitCode, 0);
    } finally {
      f.cleanup();
    }
  });

  test("cannot read the clipboard or capture the screen", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.env.root, "work"));
      const r = await call<{ output: string }>(f.env, { op: "exec", scope: "work", command: "pbpaste > /dev/null 2>&1; echo pbpaste=$?; screencapture -x shot.png 2>/dev/null; test -e shot.png && echo shot=yes || echo shot=no" });
      assert.match(r.output, /pbpaste=[1-9]/);
      assert.match(r.output, /shot=no/);
    } finally {
      f.cleanup();
    }
  });

  test("a timed-out command is killed with its children", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.env.root, "work"));
      const r = await call<{ timedOut: boolean; durationMs: number }>(f.env, { op: "exec", scope: "work", command: "sleep 30 & sleep 30", timeoutMs: 1000 });
      assert.equal(r.timedOut, true);
      assert.ok(r.durationMs < 5000);
    } finally {
      f.cleanup();
    }
  });
});

describe("git (sandboxed)", () => {
  test("clone from the mirror, commit, push to the inbox", async () => {
    const f = fixture();
    try {
      const scope = "worktrees/demo/fix";
      const cloned = await call<{ head: string }>(f.env, { op: "git.clone", scope, mirror: "demo.git", branch: "swarm/demo/fix-readme", base: "main" });
      assert.match(cloned.head, /^[0-9a-f]{40}$/);
      writeFileSync(join(f.env.root, scope, "README.md"), "hello world\n");
      const committed = await call<{ head: string }>(f.env, { op: "git.commit", scope, message: "Fix README" });
      assert.ok(committed.head);
      await assert.rejects(call(f.env, { op: "git.commit", scope, message: "again" }), { code: "conflict" });
      const pushed = await call<{ inbox: string; head: string }>(f.env, { op: "git.pushInbox", scope, branch: "swarm/demo/fix-readme" });
      assert.equal(pushed.inbox, join(f.layout.inbox, "ws-1.git"));
      const status = await call<{ status: string }>(f.env, { op: "git.status", scope });
      assert.match(status.status, /swarm\/demo\/fix-readme/);
    } finally {
      f.cleanup();
    }
  });

  test("branch names follow swarm/<project>/<part>", () => {
    for (const ok of ["swarm/demo/fix", "swarm/demo/login/oauth", "swarm/my-app/part-1/sub-2/leaf"]) assert.ok(BRANCH_PATTERN.test(ok), ok);
    for (const bad of ["main", "swarm/demo", "swarm/Demo/fix", "swarm/demo/../x", "swarm/demo/a.lock", "swarm/demo/a/b/c/d/e/f", "feature/x"]) assert.ok(!BRANCH_PATTERN.test(bad), bad);
  });
});

describe("identity and profile", () => {
  test("parses id -P and rejects junk", () => {
    assert.deepEqual(parsePasswdLine("ws-1:********:503:501::0:0:agentSwarm 1:/Users/ws-1:/usr/bin/false\n"), { username: "ws-1", uid: 503, home: "/Users/ws-1" });
    assert.throws(() => parsePasswdLine("ws-1:*:x:501::0:0:g:/Users/ws-1:/bin/sh"));
  });

  test("the profile denies the volume and homes, then allows only this workstation", () => {
    const f = fixture();
    try {
      const p = sandboxProfile(f.env);
      assert.ok(p.indexOf(`(deny file-read* file-write* (subpath ${JSON.stringify(f.layout.volume)}))`) < p.indexOf(`(allow file-read* file-write* (subpath ${JSON.stringify(f.env.root)}))`));
      assert.ok(!p.includes(f.other));
    } finally {
      f.cleanup();
    }
  });
});
