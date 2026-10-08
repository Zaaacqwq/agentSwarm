import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";
import type { Request, Response } from "../src/protocol.ts";
import { fixture, makeMirror, sh } from "./fixture.ts";

type Ok = Extract<Response, { ok: true }>;
const okResult = (r: Response) => {
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  return (r as Ok).result as Record<string, unknown>;
};

async function withWorktree() {
  const f = fixture();
  const mirror = await makeMirror(f.layout);
  const scope = "worktrees/demo/ada-fix";
  okResult(await dispatch(f.env, { op: "git.clone", scope, mirror, branch: "hive/ada/fix", base: "main" }));
  return { ...f, scope, run: (r: Request) => dispatch(f.env, r) };
}

describe("paths and scopes", () => {
  test("rejects traversal, absolute paths and bad scopes", async () => {
    const { run, scope } = await withWorktree();
    for (const path of ["../../ws-2/theirs.txt", "/etc/passwd", "a/../../../x"]) {
      const res = await run({ op: "fs.read", scope, path });
      expect(res).toMatchObject({ ok: false, code: "out_of_scope" });
    }
    for (const bad of ["../ws-2", "/abs", "worktrees/../..", "a//b", ""]) {
      expect(await run({ op: "fs.list", scope: bad, path: "." })).toMatchObject({ ok: false, code: "bad_request" });
    }
  });

  test("rejects symlinks that point outside the scope", async () => {
    const { run, scope, env, layout } = await withWorktree();
    symlinkSync(join(layout.wsRoot, "ws-2"), join(env.root, scope, "escape"));
    expect(await run({ op: "fs.read", scope, path: "escape/theirs.txt" })).toMatchObject({ ok: false, code: "out_of_scope" });
    expect(await run({ op: "fs.write", scope, path: "escape/new.txt", content: "x" })).toMatchObject({ ok: false, code: "out_of_scope" });
  });

  test("refuses to write inside .git", async () => {
    const { run, scope } = await withWorktree();
    expect(await run({ op: "fs.write", scope, path: ".git/hooks/pre-commit", content: "evil" })).toMatchObject({ ok: false, code: "out_of_scope" });
  });
});

describe("file ops", () => {
  test("write, read with paging, edit and list", async () => {
    const { run, scope } = await withWorktree();
    okResult(await run({ op: "fs.write", scope, path: "src/a.ts", content: "one\ntwo\nthree\ntwo\n" }));
    expect(okResult(await run({ op: "fs.read", scope, path: "src/a.ts", offset: 2, limit: 2 }))).toMatchObject({ content: "two\nthree", totalLines: 5, truncated: true });
    expect(await run({ op: "fs.edit", scope, path: "src/a.ts", oldText: "two", newText: "2" })).toMatchObject({ ok: false, code: "conflict" });
    expect(okResult(await run({ op: "fs.edit", scope, path: "src/a.ts", oldText: "two", newText: "2", replaceAll: true }))).toMatchObject({ replacements: 2 });
    expect(await run({ op: "fs.edit", scope, path: "src/a.ts", oldText: "missing", newText: "x" })).toMatchObject({ ok: false, code: "not_found" });
    const entries = okResult(await run({ op: "fs.list", scope, path: ".", depth: 2 })).entries as string[];
    expect(entries).toContain("src/a.ts");
    expect(entries).toContain(".git/");
    expect(entries.some((e) => e.startsWith(".git/objects"))).toBe(false);
    expect(await run({ op: "fs.read", scope, path: "nope.ts" })).toMatchObject({ ok: false, code: "not_found" });
  });

  test("grep finds matches relative to the worktree", async () => {
    const { run, scope } = await withWorktree();
    okResult(await run({ op: "fs.write", scope, path: "lib/x.ts", content: "export const needle = 1;\n" }));
    const res = okResult(await run({ op: "fs.grep", scope, pattern: "needle" }));
    expect(res.matches).toEqual(["lib/x.ts:1:export const needle = 1;"]);
  });
});

describe("exec under the sandbox", () => {
  test("runs commands in the worktree and reports exit codes", async () => {
    const { run, scope } = await withWorktree();
    const res = okResult(await run({ op: "exec", scope, command: "pwd && echo hi && exit 3" }));
    expect(res.exitCode).toBe(3);
    expect(String(res.output)).toContain("ada-fix");
    expect(String(res.output)).toContain("hi");
  });

  test("cannot read hived data, other workstations, /Volumes or other homes", async () => {
    const { run, scope, layout } = await withWorktree();
    const probes = [
      join(layout.hivedData, "master.key"),
      join(layout.wsRoot, "ws-2", "theirs.txt"),
      "/Volumes/Data/Code/agentswarm/package.json",
      "/Users/zaaac/.zshrc",
    ];
    for (const target of probes) {
      const res = okResult(await run({ op: "exec", scope, command: `cat ${JSON.stringify(target)}` }));
      expect(res.exitCode).not.toBe(0);
    }
  });

  test("environment is minimal and does not inherit secrets", async () => {
    process.env.HIVE_TEST_SECRET = "leak-me";
    const { run, scope } = await withWorktree();
    const res = okResult(await run({ op: "exec", scope, command: "env" }));
    expect(String(res.output)).not.toContain("leak-me");
    expect(String(res.output)).toContain("HOME=");
  });

  test("times out and truncates long output", async () => {
    const { run, scope } = await withWorktree();
    const slow = okResult(await run({ op: "exec", scope, command: "sleep 5", timeoutMs: 1000 }));
    expect(slow.timedOut).toBe(true);
    const loud = okResult(await run({ op: "exec", scope, command: "yes hive | head -c 200000" }));
    expect(loud.truncated).toBe(true);
    expect(String(loud.output).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("git ops", () => {
  test("clone, commit, and push to the private inbox", async () => {
    const { run, scope, layout } = await withWorktree();
    okResult(await run({ op: "fs.write", scope, path: "fix.txt", content: "fixed\n" }));
    expect(String(okResult(await run({ op: "git.status", scope })).status)).toContain("fix.txt");
    const { head } = okResult(await run({ op: "git.commit", scope, message: "fix: thing" }));
    expect(head).toBeTruthy();
    expect(await run({ op: "git.commit", scope, message: "again" })).toMatchObject({ ok: false, code: "conflict" });
    const pushed = okResult(await run({ op: "git.pushInbox", scope, branch: "hive/ada/fix" }));
    const inboxHead = (await sh(join(layout.inbox, "ws-1.git"), "git", "rev-parse", "refs/heads/hive/ada/fix")).trim();
    expect(inboxHead).toBe(String(pushed.head));
    expect(await run({ op: "git.pushInbox", scope, branch: "hive/ada/other" })).toMatchObject({ ok: false, code: "conflict" });
  });

  test("validates branches, scopes and mirrors", async () => {
    const { run, layout } = await withWorktree();
    expect(await run({ op: "git.clone", scope: "worktrees/demo/x", mirror: "demo.git", branch: "main", base: "main" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await run({ op: "git.clone", scope: "elsewhere", mirror: "demo.git", branch: "hive/a/b", base: "main" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await run({ op: "git.clone", scope: "worktrees/demo/y", mirror: "../hived.git", branch: "hive/a/b", base: "main" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await run({ op: "git.clone", scope: "worktrees/demo/ada-fix", mirror: "demo.git", branch: "hive/ada/fix", base: "main" })).toMatchObject({ ok: false, code: "conflict" });
    mkdirSync(join(layout.volume, "outside.git"));
    expect(await run({ op: "git.clone", scope: "worktrees/demo/z", mirror: "missing.git", branch: "hive/a/b", base: "main" })).toMatchObject({ ok: false, code: "not_found" });
  });

  test("remove deletes the worktree", async () => {
    const { run, scope, env } = await withWorktree();
    okResult(await run({ op: "git.remove", scope }));
    expect(existsSync(join(env.root, scope))).toBe(false);
  });
});

describe("dispatch", () => {
  test("unknown ops are rejected and info reports identity", async () => {
    const { env } = fixture();
    expect(await dispatch(env, { op: "nope" } as unknown as Request)).toMatchObject({ ok: false, code: "bad_request" });
    expect(okResult(await dispatch(env, { op: "info" }))).toMatchObject({ user: "ws-1", sandbox: true });
    writeFileSync(join(env.root, "x"), "y");
  });
});
