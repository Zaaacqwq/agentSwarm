// ws-exec: runs one workstation operation as the invoking OS user, reached only through
// `sudo -n -H -u ws-N /usr/local/libexec/hive/ws-exec`. The workstation comes from the OS user,
// never from the request.
import { lstatSync } from "node:fs";
import { PRODUCTION_LAYOUT, WS_USER_PATTERN, type ExecEnv } from "./layout.ts";
import { currentUser } from "./passwd.ts";
import { dispatch } from "./dispatch.ts";
import { killAllOnSignal } from "./process.ts";
import type { Request, Response } from "./protocol.ts";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
  try {
    request = JSON.parse(await readStdin()) as Request;
  } catch (error) {
    return fail(`Bad request: ${(error as Error).message}`);
  }
  const env: ExecEnv = { user: me.username, home: me.home, root, layout: PRODUCTION_LAYOUT, sandbox: true };
  return dispatch(env, request);
}

function fail(error: string): Response {
  return { ok: false, code: "bad_request", error };
}

process.stdout.write(`${JSON.stringify(await main())}\n`);
