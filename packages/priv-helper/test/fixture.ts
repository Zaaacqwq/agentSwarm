import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecEnv, Layout } from "../src/layout.ts";

/** A throwaway workstation layout under /tmp, shaped like /Volumes/HiveWS. */
export function fixture(sandbox = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-exec-")));
  const layout: Layout = {
    volume: base,
    wsRoot: join(base, "ws"),
    mirrors: join(base, "mirrors"),
    inbox: join(base, "inbox"),
    hivedData: join(base, "hived"),
    binDir: join(base, "bin"),
  };
  for (const d of [layout.wsRoot, layout.mirrors, layout.hivedData, join(layout.inbox, "ws-1.git"), join(layout.wsRoot, "ws-1"), join(layout.wsRoot, "ws-2"), join(base, "home-ws-1")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(layout.hivedData, "master.key"), "secret-master-key");
  writeFileSync(join(layout.wsRoot, "ws-2", "theirs.txt"), "other workstation");
  const env: ExecEnv = { user: "ws-1", home: join(base, "home-ws-1"), root: join(layout.wsRoot, "ws-1"), layout, sandbox };
  return { base, layout, env };
}

export async function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

/** Creates <mirrors>/demo.git with one commit on main. */
export async function makeMirror(layout: Layout): Promise<string> {
  const src = join(layout.volume, "src");
  mkdirSync(src);
  await sh(src, "git", "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# demo\n");
  await sh(src, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  await sh(src, "git", "add", ".");
  await sh(src, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "readme");
  await sh(layout.mirrors, "git", "clone", "-q", "--bare", src, "demo.git");
  return "demo.git";
}
