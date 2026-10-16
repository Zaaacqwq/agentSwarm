export interface OsUser {
  readonly username: string;
  readonly uid: number;
  readonly home: string;
}

/**
 * The user this process runs as, from the user database. Bun's os.userInfo() takes the name
 * and home from $USER and $HOME, and macOS sudo keeps the caller's HOME; neither is trusted.
 */
export function currentUser(): OsUser {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("No uid on this platform");
  const out = Bun.spawnSync(["/usr/bin/id", "-P", String(uid)], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  if (out.exitCode !== 0) throw new Error(`No user database entry for uid ${uid}`);
  const user = parsePasswdLine(out.stdout.toString());
  if (user.uid !== uid) throw new Error(`User database returned uid ${user.uid} for ${uid}`);
  return user;
}

/** Parses one `id -P` line: name:passwd:uid:gid:class:change:expire:gecos:home:shell */
export function parsePasswdLine(line: string): OsUser {
  const fields = line.trim().split(":");
  if (fields.length !== 10) throw new Error("Malformed user database entry");
  const uid = Number(fields[2]);
  const home = fields[8] ?? "";
  if (!fields[0] || !Number.isInteger(uid) || !home.startsWith("/")) throw new Error("Malformed user database entry");
  return { username: fields[0], uid, home };
}
