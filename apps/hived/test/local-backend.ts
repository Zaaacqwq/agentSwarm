import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layout } from "@hive/priv-helper";
import { LocalBackend } from "../src/workstations/backend.ts";

/** A HiveWS-shaped layout under /tmp with ws-1 and ws-2 prepared, as the setup script would. */
export function localBackend(sandbox = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-ws-")));
  const layout: Layout = {
    volume: base,
    wsRoot: join(base, "ws"),
    mirrors: join(base, "mirrors"),
    inbox: join(base, "inbox"),
    hivedData: join(base, "hived"),
    binDir: join(base, "bin"),
  };
  for (const user of ["ws-1", "ws-2"]) {
    mkdirSync(join(layout.wsRoot, user), { recursive: true });
    mkdirSync(join(layout.inbox, `${user}.git`), { recursive: true });
    mkdirSync(join(base, "home", user), { recursive: true });
  }
  mkdirSync(layout.mirrors, { recursive: true });
  mkdirSync(layout.hivedData, { recursive: true });
  return { backend: new LocalBackend(layout, (u) => join(base, "home", u), sandbox), layout, base };
}
