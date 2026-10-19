// Local password recovery for the dashboard admin. Works on the database file directly, so only
// someone who can already read the swarmd data dir can use it; there is no HTTP route for this.
//
//   node apps/swarmd/src/reset-password.ts --out <file> [--user admin]
//
// A new random password is written to <file> (created 0600, never overwritten) as SWARM_PASSWORD=...
// and never printed. All of that user's sessions end.
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { AuthService } from "./auth/auth-service.ts";

const { values } = parseArgs({ options: { user: { type: "string", default: "admin" }, out: { type: "string" } } });
if (!values.out) {
  process.stderr.write("usage: node apps/swarmd/src/reset-password.ts --out <file> [--user admin]\n");
  process.exit(2);
}
const password = randomBytes(18).toString("base64url");
// Write the password before changing anything: a reset nobody can read would lock the user out.
const fd = openSync(values.out, "wx", 0o600);
writeSync(fd, `SWARM_PASSWORD=${password}\n`);
closeSync(fd);
let database: ReturnType<typeof openDatabase> | undefined;
try {
  database = openDatabase(join(loadConfig().dataDir, "agentswarm.db"));
  await new AuthService(database.db).resetPassword(values.user!, password);
  process.stderr.write(`Password for ${values.user} reset; it is in ${values.out}. Existing sessions were signed out.\n`);
} catch (error) {
  rmSync(values.out, { force: true });
  throw error;
} finally {
  database?.close();
}
