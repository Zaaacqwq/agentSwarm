import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecEnv, Layout } from "../src/layout.ts";

/** A throwaway HiveWS look-alike: two workstation roots, a mirror with one commit, inboxes. */
export function fixture(sandbox = true): { env: ExecEnv; other: string; layout: Layout; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ws-exec-test-")));
  const volume = join(base, "HiveWS");
  const layout: Layout = {
    volume,
    wsRoot: join(volume, "ws"),
    mirrors: join(volume, "mirrors"),
    inbox: join(volume, "inbox"),
    hivedData: join(volume, "hived"),
    nodeBin: process.execPath.replace(/\/node$/, ""),
    hivedPort: 4318,
  };
  const root = join(layout.wsRoot, "ws-1");
  const other = join(layout.wsRoot, "ws-2");
  const home = join(base, "home");
  for (const d of [root, other, home, layout.mirrors, join(layout.inbox, "ws-1.git"), layout.hivedData]) mkdirSync(d, { recursive: true });
  writeFileSync(join(other, "secret.txt"), "other workstation\n");
  writeFileSync(join(layout.hivedData, "master.key"), "not for agents\n");

  const src = join(base, "src");
  mkdirSync(src);
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", args, { cwd, stdio: "pipe" });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", src, join(layout.mirrors, "demo.git"));

  const env: ExecEnv = { user: "ws-1", home, root, layout, sandbox, reapAll: false };
  return { env, other, layout, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
