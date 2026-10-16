import { execFileSync } from "node:child_process";

export interface OsUser {
  readonly username: string;
  readonly uid: number;
  readonly home: string;
}

/**
 * The user this process runs as, from the user database. $USER and $HOME are not trusted:
 * macOS sudo keeps the caller's HOME unless told otherwise.
 */
export function currentUser(): OsUser {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("No uid on this platform");
  const out = execFileSync("/usr/bin/id", ["-P", String(uid)], { env: {}, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const user = parsePasswdLine(out);
  if (user.uid !== uid) throw new Error(`User database returned uid ${user.uid} for ${uid}`);
  return user;
}

/** One `id -P` line: name:passwd:uid:gid:class:change:expire:gecos:home:shell */
export function parsePasswdLine(line: string): OsUser {
  const fields = line.trim().split(":");
  if (fields.length !== 10) throw new Error("Malformed user database entry");
  const uid = Number(fields[2]);
  const home = fields[8] ?? "";
  if (!fields[0] || !Number.isInteger(uid) || !home.startsWith("/")) throw new Error("Malformed user database entry");
  return { username: fields[0], uid, home };
}
