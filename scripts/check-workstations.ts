#!/usr/bin/env bun
// On-machine integration check for P2 workstations. Run as your normal user AFTER
// `sudo zsh scripts/setup-workstations.sh`:   bun scripts/check-workstations.ts
// Uses the real sudo + hive-exec path. Creates and removes a throwaway probe mirror.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacosUserBackend, WorkstationError } from "../apps/hived/src/workstations/backend.ts";

const backend = new MacosUserBackend();
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
};

interface Exec { exitCode: number | null; output: string }

async function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

async function main(): Promise<void> {
  const health = await backend.health();
  record("backend health", health.ready, health.reason ?? "");
  if (!health.ready) return;

  for (const user of ["ws-1", "ws-2"]) {
    try {
      const info = await backend.call<{ user: string; sandbox: boolean }>(user, { op: "info" });
      record(`hive-exec runs as ${user}`, info.user === user && info.sandbox, JSON.stringify(info));
    } catch (e) {
      record(`hive-exec runs as ${user}`, false, (e as Error).message);
    }
  }
  try {
    await backend.call("ws-hive-p0", { op: "info" });
    record("non-workstation users refused", false);
  } catch (e) {
    record("non-workstation users refused", e instanceof WorkstationError, (e as Error).message.slice(0, 80));
  }

  // A tiny probe repo so commands can run inside a real worktree scope.
  const src = mkdtempSync(join(tmpdir(), "hive-probe-"));
  await sh(src, "git", "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "probe\n");
  await sh(src, "git", "add", ".");
  await sh(src, "git", "-c", "user.name=probe", "-c", "user.email=p@p", "commit", "-qm", "probe");
  const mirror = join(backend.layout.mirrors, "_probe.git");
  rmSync(mirror, { recursive: true, force: true });
  await sh(backend.layout.mirrors, "git", "clone", "-q", "--bare", "--config", "core.sharedRepository=0644", src, "_probe.git");
  await sh(backend.layout.mirrors, "chmod", "-R", "a+rX", "_probe.git");
  const scope = "worktrees/_probe/check";

  try {
    await backend.call("ws-1", { op: "git.remove", scope }).catch(() => {});
    await backend.call("ws-1", { op: "git.clone", scope, mirror: "_probe.git", branch: "hive/check/probe", base: "main" });
    record("ws-1 clones from the mirror", true);

    const run = (command: string) => backend.call<Exec>("ws-1", { op: "exec", scope, command, timeoutMs: 30_000 });
    const whoami = await run("id -un; id -Gn");
    record("commands run as ws-1, not in staff", whoami.output.startsWith("ws-1") && !/\bstaff\b/.test(whoami.output), whoami.output.replace(/\n/g, " | "));

    const denied: [string, string][] = [
      ["your home", "cat ~zaaac/.zshrc"],
      ["/Volumes/Data", "ls /Volumes/Data/Code"],
      ["hived data", `ls ${backend.layout.hivedData}`],
      ["ws-2's workstation", `ls ${backend.layout.wsRoot}/ws-2`],
      ["ws-2's inbox", `ls ${backend.layout.inbox}/ws-2.git`],
    ];
    for (const [label, command] of denied) {
      const res = await run(command);
      record(`cannot read ${label}`, res.exitCode !== 0, res.output.split("\n")[0]?.slice(0, 90) ?? "");
    }

    const net = await run("curl -sS -o /dev/null -w '%{http_code}' https://example.com");
    record("network allowed", net.output.trim() === "200", net.output.trim());
    const bun = await run("bun --version");
    record("bun available to agents", bun.exitCode === 0, bun.output.trim());

    await backend.call("ws-1", { op: "fs.write", scope, path: "note.txt", content: "hello\n" });
    const read = await backend.call<{ content: string }>("ws-1", { op: "fs.read", scope, path: "note.txt" });
    record("file write/read in worktree", read.content === "hello\n");
    const escape = await backend.call("ws-1", { op: "fs.read", scope, path: "../../../ws-2/x" }).then(() => false, () => true);
    record("path traversal refused", escape);

    await backend.call("ws-1", { op: "git.commit", scope, message: "probe commit" });
    const pushed = await backend.call<{ head: string; inbox: string }>("ws-1", { op: "git.pushInbox", scope, branch: "hive/check/probe" });
    const seen = await sh("/", "git", "-c", `safe.directory=${pushed.inbox}`, "--git-dir", pushed.inbox, "rev-parse", "refs/heads/hive/check/probe");
    record("hived can read ws-1's inbox", seen === pushed.head, seen.slice(0, 10));

    await backend.call("ws-1", { op: "tmux.create", scope, name: "probe" });
    await backend.call("ws-1", { op: "tmux.send", name: "probe", keys: "echo tmux-ok" });
    await Bun.sleep(500);
    const screen = await backend.call<{ output: string }>("ws-1", { op: "tmux.read", name: "probe", lines: 20 });
    record("tmux terminal works", screen.output.includes("tmux-ok"));
    const tmuxDenied = await backend.call("ws-1", { op: "tmux.send", name: "probe", keys: "cat ~zaaac/.zshrc > /dev/null && echo LEAK || echo blocked" }).then(async () => {
      await Bun.sleep(500);
      return (await backend.call<{ output: string }>("ws-1", { op: "tmux.read", name: "probe", lines: 20 })).output;
    });
    // Match whole output lines: the echoed command line itself contains both words.
    const lines = tmuxDenied.split("\n").map((l) => l.trim());
    record("tmux shell is sandboxed", lines.includes("blocked") && !lines.includes("LEAK"), tmuxDenied.split("\n").slice(-6).join(" | "));
    await backend.call("ws-1", { op: "tmux.kill", name: "probe" });
  } catch (e) {
    record("unexpected error", false, (e as Error).message.slice(0, 200));
  } finally {
    await backend.call("ws-1", { op: "git.remove", scope }).catch(() => {});
    rmSync(mirror, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
}

await main();
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
