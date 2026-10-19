// ws-exec: runs one workstation operation as the invoking OS user, reached only through
// `sudo -n -H -u ws-N /usr/local/libexec/agentswarm/ws-exec`. The workstation comes from the OS user,
// never from the request.
import { lstatSync } from "node:fs";
import { PRODUCTION_LAYOUT, WS_USER_PATTERN, type ExecEnv } from "./layout.ts";
import { currentUser } from "./passwd.ts";
import { dispatch } from "./dispatch.ts";
import { killAllOnSignal } from "./process.ts";
import type { Request, Response } from "./protocol.ts";
import { readRequest } from "./input.ts";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

async function main(): Promise<Response> {
  process.umask(0o077);
  killAllOnSignal();
  let me;
  try {
    me = currentUser();
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!WS_USER_PATTERN.test(me.username)) return fail(`ws-exec only runs as a workstation user, not ${me.username}`);
  const root = `${PRODUCTION_LAYOUT.wsRoot}/${me.username}`;
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return fail(`Workstation root ${root} is missing; run scripts/setup.sh`);
  }
  if (!st.isDirectory() || st.uid !== me.uid) return fail(`Workstation root ${root} must be a directory owned by ${me.username}`);
  let request: Request;
  let rest: AsyncIterable<string>;
  try {
    const read = await readRequest(process.stdin, MAX_REQUEST_BYTES);
    request = JSON.parse(read.request) as Request;
    rest = read.rest;
  } catch (error) {
    return fail(`Bad request: ${(error as Error).message}`);
  }
  const env: ExecEnv = { user: me.username, home: me.home, root, layout: PRODUCTION_LAYOUT, sandbox: true, reapAll: true };
  return dispatch(env, request, writeEvent, rest);
}

function writeEvent(event: unknown): void {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

function fail(error: string): Response {
  return { ok: false, code: "bad_request", error };
}

// Exit once the response is out: a session's stdin may still be open.
process.stdout.write(`${JSON.stringify(await main())}\n`, () => process.exit(0));
