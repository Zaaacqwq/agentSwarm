// Test-only entry: runs one request with a layout and identity given by the caller.
// Never installed (scripts/setup.sh copies main.ts and its imports only).
import { dispatch } from "./dispatch.ts";
import { killAllOnSignal } from "./process.ts";
import type { ExecEnv } from "./layout.ts";
import type { Request } from "./protocol.ts";
import { readRequest } from "./input.ts";

killAllOnSignal();
const parsed = JSON.parse(process.env.WS_EXEC_TEST_ENV ?? "null") as ExecEnv | null;
if (!parsed) throw new Error("WS_EXEC_TEST_ENV is not set");
// Tests run as the developer: reap must never kill everything they own.
const env: ExecEnv = { ...parsed, reapAll: false };
const { request: line, rest } = await readRequest(process.stdin, 4 * 1024 * 1024);
const request = JSON.parse(line) as Request;
const response = await dispatch(env, request, (event) => process.stdout.write(`${JSON.stringify({ event })}\n`), rest);
process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
