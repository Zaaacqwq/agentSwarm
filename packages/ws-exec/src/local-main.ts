// Test-only entry: runs one request with a layout and identity given by the caller.
// Never installed (scripts/setup.sh copies main.ts and its imports only).
import { dispatch } from "./dispatch.ts";
import { killAllOnSignal } from "./process.ts";
import type { ExecEnv } from "./layout.ts";
import type { Request } from "./protocol.ts";

killAllOnSignal();
const parsed = JSON.parse(process.env.WS_EXEC_TEST_ENV ?? "null") as ExecEnv | null;
if (!parsed) throw new Error("WS_EXEC_TEST_ENV is not set");
// Tests run as the developer: reap must never kill everything they own.
const env: ExecEnv = { ...parsed, reapAll: false };
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
process.stdout.write(`${JSON.stringify(await dispatch(env, request))}\n`);
