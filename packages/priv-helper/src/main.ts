#!/usr/bin/env bun
// hive-exec: runs one workstation operation as the invoking OS user (reached via
// `sudo -n -u ws-N`). The workstation root comes from the OS user, never from input.
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { PRODUCTION_LAYOUT, WS_USER_PATTERN, type ExecEnv } from "./layout.ts";
import { dispatch } from "./dispatch.ts";
import type { Request, Response } from "./protocol.ts";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

async function main(): Promise<Response> {
  process.umask(0o027);
  const me = userInfo();
  if (!WS_USER_PATTERN.test(me.username)) return fail(`hive-exec only runs as a workstation user, not ${me.username}`);
  const root = `${PRODUCTION_LAYOUT.wsRoot}/${me.username}`;
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return fail(`Workstation root ${root} is missing`);
  }
  if (!st.isDirectory() || st.uid !== me.uid) return fail(`Workstation root ${root} must be a directory owned by ${me.username}`);

  const raw = await Bun.stdin.text();
  if (raw.length > MAX_REQUEST_BYTES) return fail("Request too large");
  let request: Request;
  try {
    request = JSON.parse(raw) as Request;
  } catch {
    return fail("Request is not JSON");
  }
  const env: ExecEnv = { user: me.username, home: me.homedir, root, layout: PRODUCTION_LAYOUT, sandbox: true };
  return dispatch(env, request);
}

function fail(error: string): Response {
  return { ok: false, code: "bad_request", error };
}

const response = await main().catch((e: unknown): Response => ({ ok: false, code: "failed", error: String(e).slice(0, 500) }));
process.stdout.write(JSON.stringify(response));
