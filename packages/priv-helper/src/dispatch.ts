import type { ExecEnv } from "./layout.ts";
import { OpError, type Request, type Response } from "./protocol.ts";
import * as fs from "./ops/fs.ts";
import { exec } from "./ops/exec.ts";
import * as tmux from "./ops/tmux.ts";
import * as git from "./ops/git.ts";

export async function dispatch(env: ExecEnv, request: Request): Promise<Response> {
  try {
    return { ok: true, result: await run(env, request) };
  } catch (error) {
    if (error instanceof OpError) return { ok: false, code: error.code, error: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "failed", error: message.slice(0, 500) };
  }
}

async function run(env: ExecEnv, r: Request): Promise<unknown> {
  switch (r.op) {
    case "fs.list": return fs.list(env, r.scope, r.path, r.depth);
    case "fs.read": return fs.read(env, r.scope, r.path, r.offset, r.limit);
    case "fs.write": return fs.write(env, r.scope, r.path, r.content);
    case "fs.edit": return fs.edit(env, r.scope, r.path, r.oldText, r.newText, r.replaceAll);
    case "fs.grep": return fs.grep(env, r.scope, r.pattern, r.path, r.glob, r.maxResults);
    case "exec": return exec(env, r.scope, r.command, r.timeoutMs);
    case "tmux.create": return tmux.create(env, r.scope, r.name);
    case "tmux.send": return tmux.send(env, r.name, r.keys, r.enter);
    case "tmux.read": return tmux.read(env, r.name, r.lines);
    case "tmux.kill": return tmux.kill(env, r.name);
    case "tmux.list": return tmux.listSessions(env);
    case "git.clone": return git.clone(env, r.scope, r.mirror, r.branch, r.base);
    case "git.status": return git.status(env, r.scope);
    case "git.commit": return git.commit(env, r.scope, r.message);
    case "git.pushInbox": return git.pushInbox(env, r.scope, r.branch);
    case "git.remove": return git.remove(env, r.scope);
    case "info": return { user: env.user, root: env.root, sandbox: env.sandbox };
    default: throw new OpError("bad_request", `Unknown op ${(r as { op?: unknown }).op}`);
  }
}
