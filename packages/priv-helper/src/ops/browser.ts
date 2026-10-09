import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { ExecEnv } from "../layout.ts";
import { OpError } from "../protocol.ts";
import { childEnv } from "../process.ts";
import { browserSandboxProfile, sandboxed } from "../sandbox.ts";
import type { BrowserRequest, BrowserResponse } from "../browser/protocol.ts";

const KEY = /^[a-z0-9_]{1,48}$/;
const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 90_000;

function paths(env: ExecEnv, agent: string) {
  if (!KEY.test(agent)) throw new OpError("bad_request", "Invalid browser key");
  // Outside the agent sandbox: the agent's shell must not reach the socket or the profile.
  const dir = join(env.layout.browserState, env.user);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new OpError("failed", "The browser state directory is missing; rerun the workstation setup script");
  }
  const socket = join(dir, `${agent}.sock`);
  // macOS limits Unix socket paths to 104 bytes.
  if (Buffer.byteLength(socket) > 100) throw new OpError("failed", `Browser socket path is too long: ${socket}`);
  return { dir, socket, profile: join(dir, agent), log: join(dir, `${agent}.log`), tmp: join(dir, ".tmp") };
}

/** Sends one command to the agent's browser daemon, starting it (sandboxed, as this user) if needed. */
export async function browser(env: ExecEnv, agent: string, request: BrowserRequest): Promise<BrowserResponse> {
  const p = paths(env, agent);
  try {
    return await send(p.socket, request);
  } catch (error) {
    // Only a daemon that is not there gets (re)started; a slow or failing one reports its error.
    if (!(error instanceof Unreachable)) throw error;
    await start(env, p);
    return send(p.socket, request);
  }
}

class Unreachable extends Error {}

export async function reset(env: ExecEnv, agent: string): Promise<{ reset: true }> {
  const p = paths(env, agent);
  await send(p.socket, { command: { cmd: "shutdown" }, approvals: [] }).catch(() => null);
  // The daemon removes its socket as it exits; wait for that before deleting the profile under Chrome.
  for (let i = 0; i < 40 && existsSync(p.socket); i++) await Bun.sleep(150);
  rmSync(p.profile, { recursive: true, force: true });
  rmSync(p.socket, { force: true });
  return { reset: true };
}

/** One starter at a time per agent; a concurrent caller waits for the other's daemon instead. */
async function start(env: ExecEnv, p: ReturnType<typeof paths>): Promise<void> {
  const lock = `${p.socket}.starting`;
  try {
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > START_TIMEOUT_MS * 2) rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(p.socket) && !existsSync(lock)) return;
      await Bun.sleep(150);
    }
    throw new OpError("timeout", "Browser did not start in time");
  }
  try {
    await launch(env, p);
  } finally {
    rmSync(lock, { force: true });
  }
}

async function launch(env: ExecEnv, p: ReturnType<typeof paths>): Promise<void> {
  const daemon = join(env.layout.browserDir, "daemon.js");
  if (!existsSync(daemon)) throw new OpError("failed", "The browser is not installed; rerun the workstation setup script");
  rmSync(p.socket, { force: true });
  mkdirSync(p.tmp, { recursive: true, mode: 0o700 });
  // A daemon that died uncleanly leaves Chrome's profile lock behind, which makes the next Chrome abort.
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(p.profile, lock), { force: true });
  const log = openSync(p.log, "a", 0o600);
  const allow = env.layout.browserAllowHosts?.join(",") ?? "";
  const argv = [join(env.layout.binDir, "bun"), daemon, p.socket, p.profile, ...(allow ? [allow] : [])];
  const proc = Bun.spawn(sandboxed(env, argv, browserSandboxProfile(env, p.dir)), {
    cwd: p.dir,
    env: { ...childEnv(env), TMPDIR: `${p.tmp}/` },
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  proc.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new OpError("failed", `Browser exited during start (code ${proc.exitCode})`);
    if (existsSync(p.socket)) return;
    await Bun.sleep(150);
  }
  proc.kill();
  throw new OpError("timeout", "Browser did not start in time");
}

function send(socket: string, request: BrowserRequest): Promise<BrowserResponse> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let connected = false;
    let settled = false;
    // Callers may spawn right after this (the daemon on a failed connect). Bun 1.3.0 closes a
    // socket's descriptor after its close event, and a spawn in between can reuse that descriptor;
    // so settle only one macrotask after the socket is gone.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (conn.closed) return void setTimeout(fn, 1);
      conn.once("close", () => setTimeout(fn, 1));
      conn.destroy();
    };
    const timer = setTimeout(() => finish(() => reject(new OpError("timeout", "Browser command timed out"))), CALL_TIMEOUT_MS);
    const conn = connect(socket, () => {
      connected = true;
      conn.write(`${JSON.stringify(request)}\n`);
    });
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      finish(() => {
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as BrowserResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
    conn.on("error", (error) => finish(() => reject(connected ? error : new Unreachable())));
    conn.on("close", () => finish(() => reject(connected ? new OpError("failed", "Browser closed the connection without answering") : new Unreachable())));
  });
}
