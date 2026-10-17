import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";
import type { Request } from "../src/protocol.ts";
import { fixture } from "./fixture.ts";
import { installFakeCli } from "./fake-cli.ts";

const SCOPE = "worktrees/demo/t1--part";
const TOKEN = "sk-ant-oat01-test-token-0123456789";

async function call<T = Record<string, unknown>>(env: Parameters<typeof dispatch>[0], request: Request, events: unknown[] = []): Promise<T> {
  const res = await dispatch(env, request, (e) => events.push(e));
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.result as T;
}

async function setup() {
  const f = fixture(true);
  const cli = installFakeCli(f.layout.cliDir);
  await call(f.env, { op: "git.clone", scope: SCOPE, mirror: "demo.git", branch: "swarm/demo/t1/part", base: "main" });
  return { ...f, cli };
}

const run = (over: Partial<Extract<Request, { op: "cli.run" }>> = {}): Request => ({
  op: "cli.run", scope: SCOPE, runtime: "claude_code", prompt: "Fix the bug.", maxTurns: 20, timeoutMs: 60_000, credential: TOKEN, ...over,
});

describe("CLI workers (sandboxed)", () => {
  test("Claude Code: prompt on stdin, token on fd 3 (never in the environment), locked-down flags, events streamed", async () => {
    const f = await setup();
    try {
      f.cli.script([{ write: [{ path: "a.txt", content: "a\n" }], commit: "add a", quota: { five: 0.4, seven: 0.2 } }]);
      const events: { type?: string }[] = [];
      const res = await call<{ exitCode: number; timedOut: boolean; stoppedFor: null }>(f.env, run(), events);
      assert.equal(res.exitCode, 0);
      assert.equal(res.timedOut, false);
      const [c] = f.cli.calls();
      assert.equal(c!.prompt, "Fix the bug.");
      assert.equal(c!.tokenLength, TOKEN.length, "the token arrived on fd 3");
      assert.equal(c!.tokenInEnv, false, "the token is not in the environment");
      assert.ok(!c!.args.join(" ").includes(TOKEN), "the token is not in argv");
      assert.equal(c!.cwd, join(f.env.root, SCOPE));
      for (const flag of ["-p", "--strict-mcp-config"]) assert.ok(c!.args.includes(flag), flag);
      assert.equal(c!.args[c!.args.indexOf("--tools") + 1], "Bash,Read,Edit,Write,Glob,Grep");
      assert.equal(c!.args[c!.args.indexOf("--setting-sources") + 1], "");
      assert.equal(c!.args[c!.args.indexOf("--max-turns") + 1], "20");
      assert.ok(!c!.args.includes("--resume"));
      assert.deepEqual(events.map((e) => e.type), ["system", "rate_limit_event", "assistant", "user", "assistant", "user", "result"]);
      const log = await call<{ recent: string }>(f.env, { op: "git.status", scope: SCOPE });
      assert.match(log.recent, /add a/);
    } finally {
      f.cleanup();
    }
  });

  test("Codex: its own signed-in home, bundled ripgrep on PATH, resume, and a stop at maxTurns actions", async () => {
    const f = await setup();
    try {
      f.cli.script([{ tools: 10 }, {}]);
      const events: { type?: string }[] = [];
      const res = await call<{ stoppedFor: string | null; exitCode: number | null }>(f.env, run({ runtime: "codex", maxTurns: 3, credential: undefined }), events);
      assert.equal(res.stoppedFor, "turns");
      assert.equal(events.filter((e) => e.type === "item.completed").length, 3);
      await call(f.env, run({ runtime: "codex", resume: "01a14ae8-1b09-7663-b855-8ae73f83915e", credential: undefined, model: "gpt-5.5-codex" }));
      const [first, second] = f.cli.calls();
      assert.equal(first!.codexHome, join(f.env.root, ".codex"));
      assert.ok(first!.path.startsWith(join(f.layout.cliDir, "codex", "codex-path")));
      assert.ok(first!.args.includes("--dangerously-bypass-approvals-and-sandbox"));
      assert.ok(first!.args.includes('web_search="disabled"'));
      assert.equal(first!.args.at(-1), "-", "the prompt comes on stdin");
      assert.ok(existsSync(first!.args[first!.args.indexOf("--output-schema") + 1]!));
      assert.deepEqual(second!.args.slice(0, 3), ["exec", "resume", "01a14ae8-1b09-7663-b855-8ae73f83915e"]);
      assert.equal(second!.args[second!.args.indexOf("-m") + 1], "gpt-5.5-codex");
    } finally {
      f.cleanup();
    }
  });

  test("requests cannot smuggle arguments or skip the token", async () => {
    const f = await setup();
    try {
      await assert.rejects(call(f.env, run({ model: "x --dangerously-skip-permissions" })), { code: "bad_request" });
      await assert.rejects(call(f.env, run({ resume: "--settings=/tmp/x" })), { code: "bad_request" });
      await assert.rejects(call(f.env, run({ runtime: "bash" as never })), { code: "bad_request" });
      await assert.rejects(call(f.env, run({ credential: undefined })), { code: "bad_request" });
      await assert.rejects(call(f.env, run({ maxTurns: 0 })), { code: "bad_request" });
      await assert.rejects(call(f.env, run({ scope: "worktrees/demo/missing" })), { code: "not_found" });
      assert.equal(f.cli.calls().length, 0);
    } finally {
      f.cleanup();
    }
  });

  test("a CLI is sandboxed like any command: no other workstation, no swarmd data, no Codex home for Claude", async () => {
    const f = await setup();
    try {
      f.cli.script([{ probe: `cat ${join(f.other, "secret.txt")} 2>&1; cat ${join(f.layout.swarmdData, "master.key")} 2>&1; ls ${join(f.env.root, ".codex")} 2>&1; echo done` }]);
      const events: { type?: string; result?: string }[] = [];
      await call(f.env, run(), events);
      const result = events.find((e) => e.type === "result")!.result!;
      assert.doesNotMatch(result, /other workstation|not for agents/);
      assert.match(result, /Operation not permitted/);
      assert.match(result, /done/);
    } finally {
      f.cleanup();
    }
  });

  test("the time limit kills the CLI and everything it started", async () => {
    const f = await setup();
    try {
      f.cli.script([{ longLived: true, sleepMs: 60_000 }]);
      const res = await call<{ timedOut: boolean }>(f.env, run({ timeoutMs: 10_000 }));
      assert.equal(res.timedOut, true);
      const pid = f.cli.sleeperPid();
      assert.ok(pid);
      await new Promise((r) => setTimeout(r, 300));
      assert.throws(() => process.kill(pid!, 0), "the sleeper died with the CLI");
    } finally {
      f.cleanup();
    }
  });

  test("Codex sign-in streams the device code; status and sign-out follow it", async () => {
    const f = await setup();
    try {
      assert.deepEqual(await call(f.env, { op: "cli.status" }), { claude: "2.1.302", codex: "0.163.0", codexSignedIn: false });
      const lines: { text?: string }[] = [];
      const login = call<{ exitCode: number }>(f.env, { op: "cli.login", runtime: "codex" }, lines);
      setTimeout(() => f.cli.approveLogin(), 300);
      assert.equal((await login).exitCode, 0);
      const text = lines.map((l) => l.text).join("\n");
      assert.match(text, /https:\/\/auth\.openai\.com\/codex\/device/);
      assert.match(text, /FAKE-12345/);
      assert.doesNotMatch(text, /\u001b/, "colour codes are stripped");
      assert.equal((await call<{ codexSignedIn: boolean }>(f.env, { op: "cli.status" })).codexSignedIn, true);
      await call(f.env, { op: "cli.logout", runtime: "codex" });
      assert.equal((await call<{ codexSignedIn: boolean }>(f.env, { op: "cli.status" })).codexSignedIn, false);
    } finally {
      f.cleanup();
    }
  });
});
