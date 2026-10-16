#!/usr/bin/env bun
// Local password recovery for a dashboard user. Works on the database file directly, so only
// someone who can already read the hived data dir can use it; there is no HTTP route for this.
//
//   bun apps/hived/src/reset-password.ts --out <file> [--user admin]
//
// A new random password is written to <file> (created with mode 0600, never overwritten) as
// HIVE_PASSWORD=..., and never printed. All of the user's login sessions end.
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { AuthService } from "./auth/auth-service.ts";

const { values } = parseArgs({ options: { user: { type: "string", default: "admin" }, out: { type: "string" } } });
if (!values.out) {
  process.stderr.write("usage: bun apps/hived/src/reset-password.ts --out <file> [--user admin]\n");
  process.exit(2);
}

const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
// Write the password before changing anything: a reset nobody can read would lock the user out.
const fd = openSync(values.out, "wx", 0o600);
writeSync(fd, `HIVE_PASSWORD=${password}\n`);
closeSync(fd);
let database: ReturnType<typeof openDatabase> | undefined;
try {
  database = openDatabase(join(loadConfig().dataDir, "hive.db"));
  await new AuthService(database.db).resetPassword(values.user!, password);
  process.stderr.write(`Password for ${values.user} reset; it is in ${values.out}. Existing sessions were signed out.\n`);
} catch (error) {
  rmSync(values.out, { force: true });
  throw error;
} finally {
  database?.close();
}
