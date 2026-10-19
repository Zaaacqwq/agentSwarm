import { execFileSync } from "node:child_process";
import type { ExecEnv } from "./layout.ts";
import { OpError, type Request, type Response } from "./protocol.ts";
import * as fs from "./ops/fs.ts";
import { exec } from "./ops/exec.ts";
import * as git from "./ops/git.ts";
import * as cli from "./ops/cli.ts";
import * as sim from "./ops/sim.ts";
import * as browser from "./ops/browser.ts";

const NO_INPUT: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {} };

/** `emit` receives the events of streaming ops (cli.*); callers write them as `{"event": …}` lines. */
export async function dispatch(env: ExecEnv, request: Request, emit: cli.Emit = () => undefined, input: AsyncIterable<string> = NO_INPUT): Promise<Response> {
  try {
    return { ok: true, result: await run(env, request, emit, input) };
  } catch (error) {
    if (error instanceof OpError) return { ok: false, code: error.code, error: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "failed", error: message.slice(0, 500) };
  }
}

/**
 * Kills every other process of this user. Not kill(-1): on macOS that also kills the caller, so the
 * result would never be reported. A few rounds catch processes forked while the first ones die.
 */
function reap(env: ExecEnv): { reaped: number } {
  if (!env.reapAll) return { reaped: 0 };
  const uid = process.getuid?.();
  if (uid === undefined) return { reaped: 0 };
  let reaped = 0;
  for (let round = 0; round < 5; round++) {
    const out = execFileSync("/bin/ps", ["-U", String(uid), "-o", "pid="], { env: {}, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const pids = out.split("\n").map((l) => Number(l.trim())).filter((pid) => pid > 1 && pid !== process.pid);
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        reaped++;
      } catch {
        // Already gone.
      }
    }
  }
  return { reaped };
}

function run(env: ExecEnv, r: Request, emit: cli.Emit, input: AsyncIterable<string>): unknown {
  switch (r.op) {
    case "info": return { user: env.user, root: env.root, sandbox: env.sandbox };
    case "fs.list": return fs.list(env, r.scope, r.path, r.depth);
    case "fs.read": return fs.read(env, r.scope, r.path, r.offset, r.limit);
    case "fs.write": return fs.write(env, r.scope, r.path, r.content, r.encoding);
    case "fs.edit": return fs.edit(env, r.scope, r.path, r.oldText, r.newText, r.replaceAll);
    case "fs.grep": return fs.grep(env, r.scope, r.pattern, r.path, r.glob, r.maxResults);
    case "exec": return exec(env, r.scope, r.command, r.timeoutMs);
    case "git.clone": return git.clone(env, r.scope, r.mirror, r.branch, r.base, undefined, r.files);
    case "git.status": return git.status(env, r.scope);
    case "git.commit": return git.commit(env, r.scope, r.message);
    case "git.pushInbox": return git.pushInbox(env, r.scope, r.branch);
    case "git.remove": return git.remove(env, r.scope);
    case "git.merge": return git.merge(env, r.scope, r.branch, r.sha, r.message);
    case "cli.run": return cli.run(env, r, emit);
    case "cli.login": return cli.login(env, emit);
    case "cli.logout": return cli.logout(env);
    case "cli.status": return cli.status(env);
    case "reap": return reap(env);
    case "sim.boot": return sim.boot(env, r.scope, r.deviceType, r.runtime);
    case "sim.build": return sim.build(env, r.scope, r);
    case "sim.launch": return sim.launch(env, r.scope, r.bundleId, r.args);
    case "sim.ui": return sim.ui(env, r.scope);
    case "sim.tap": return sim.tap(env, r.scope, r.x, r.y);
    case "sim.type": return sim.typeText(env, r.scope, r.text);
    case "sim.swipe": return sim.swipe(env, r.scope, r.from, r.to, r.durationS);
    case "sim.button": return sim.button(env, r.scope, r.button);
    case "sim.screenshot": return sim.screenshot(env, r.scope, r.saveAs, r.region);
    case "sim.logs": return sim.logs(env, r.scope, r.process, r.seconds);
    case "sim.shutdown": return sim.shutdown(env, r.scope);
    case "browser.session": return browser.session(env, r.scope, r.interact ?? [], r.timeoutMs, input, emit);
    default: throw new OpError("bad_request", `Unknown op ${(r as { op?: unknown }).op}`);
  }
}
