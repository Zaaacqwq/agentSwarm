// Checks the real workstations through the same sudo + ws-exec path hived uses. No sudo password needed.
//   npm run check
import { homedir } from "node:os";
import type { ExecResult } from "@hive/ws-exec";
import { PRODUCTION_LAYOUT } from "@hive/ws-exec";
import { SudoBackend } from "../apps/hived/src/workstations/backend.ts";

const backend = new SudoBackend();
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const users = await backend.listUsers();
record("workstation users exist", users.length > 0, users.join(", ") || "none; run sudo zsh scripts/setup.sh");

for (const user of users) {
  try {
    const info = await backend.call<{ user: string; root: string; sandbox: boolean }>(user, { op: "info" }, { timeoutMs: 20_000 });
    record(`ws-exec runs as ${user}, sandboxed`, info.user === user && info.sandbox, info.root);
  } catch (e) {
    record(`ws-exec runs as ${user}`, false, (e as Error).message);
  }
}

const ws = users[0];
const other = users[1];
if (ws) {
  const scope = "hive-check";
  const run = (command: string) => backend.call<ExecResult>(ws, { op: "exec", scope, command, timeoutMs: 30_000 });
  const denied = async (name: string, command: string) => {
    const r = await run(command);
    record(name, r.exitCode !== 0 && /Operation not permitted|Permission denied/.test(r.output), r.output.trim().split("\n")[0]?.slice(0, 100) ?? "");
  };
  try {
    // .tmp is created on demand by every exec, so it can host the first command.
    await backend.call(ws, { op: "exec", scope: ".tmp", command: `mkdir -p ../${scope}`, timeoutMs: 10_000 });
    await backend.call(ws, { op: "fs.write", scope, path: "note.txt", content: "hello\n" });
    const own = await run("cat note.txt && echo ok > out.txt && cat out.txt");
    record(`${ws} can read and write its own files`, own.exitCode === 0 && own.output.includes("ok"));
    const id = await run("id -un; id -Gn");
    record(`commands run as ${ws}, not in staff`, id.output.startsWith(ws) && !/\bstaff\b/.test(id.output), id.output.replace(/\n/g, " | ").trim());
    await denied("cannot read your home", `cat ${JSON.stringify(`${homedir()}/.zshrc`)}`);
    await denied("cannot read /Volumes/Data", "ls /Volumes/Data");
    await denied("cannot read hived data", `ls ${PRODUCTION_LAYOUT.hivedData}`);
    if (other) {
      await denied(`cannot read ${other}'s workstation`, `ls ${PRODUCTION_LAYOUT.wsRoot}/${other}`);
      await denied(`cannot read ${other}'s inbox`, `ls ${PRODUCTION_LAYOUT.inbox}/${other}.git`);
    }
    const env = await run("env | sort | cut -d= -f1 | tr '\\n' ' '");
    const names = env.output.trim().split(/\s+/).filter((n) => !n.startsWith("GIT_CONFIG_"));
    record("no secrets in the command environment", !names.some((n) => /TOKEN|KEY|SECRET|PASSWORD/i.test(n)), names.join(" ").slice(0, 160));
    const session = await run("launchctl managername; launchctl manageruid; id -u");
    const [manager, managerUid, uid] = session.output.trim().split("\n");
    record("commands run in the workstation's own session, not yours", manager !== "Aqua" && managerUid === uid, session.output.replace(/\n/g, " ").trim());
    const node = await run("node --version && which node");
    record("Hive's Node runtime is on PATH", node.exitCode === 0 && node.output.includes("/usr/local/libexec/hive/node/bin/node"), node.output.replace(/\n/g, " ").trim());
    const net = await run("curl -s -o /dev/null -w '%{http_code}' https://github.com");
    record("network is allowed", net.output.trim() === "200", net.output.trim());
    const api = await run("curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:4318/api/health; echo \" exit=$?\"");
    record("cannot reach hived's API", !api.output.includes("200"), api.output.trim());
    const clip = await run("pbpaste > /dev/null 2>&1; echo pbpaste=$?; osascript -e 'return 1' > /dev/null 2>&1; echo osascript=$?");
    record("no clipboard or AppleScript access", !/pbpaste=0/.test(clip.output) && !/osascript=0/.test(clip.output), clip.output.replace(/\n/g, " ").trim());
    const escape = await backend.call(ws, { op: "fs.read", scope, path: "../../ws-2/x" }).then(() => false, () => true);
    record("path traversal is refused", escape);
  } catch (e) {
    record("workstation checks", false, (e as Error).message);
  } finally {
    await run("cd .. && rm -rf hive-check").catch(() => undefined);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
