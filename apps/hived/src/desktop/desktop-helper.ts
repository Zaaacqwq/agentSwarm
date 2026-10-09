import { connect } from "node:net";
import { existsSync } from "node:fs";

export interface HelperStatus {
  readonly screenRecording: boolean;
  readonly accessibility: boolean;
  readonly armed: { readonly untilMs: number; readonly holder: string } | null;
  readonly stoppedByUser: boolean;
  readonly displays: readonly { index: number; width: number; height: number; imageWidth: number; imageHeight: number; main: boolean }[];
  readonly frontmost: { readonly app?: string; readonly bundleId?: string; readonly title?: string };
}

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The hive-desktop LaunchAgent in the console user's GUI session. */
export interface DesktopHelper {
  available(): boolean;
  call<T extends object>(request: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

/** Line-delimited JSON over the helper's 0600 Unix socket in the hived data dir. */
export class SocketHelper implements DesktopHelper {
  constructor(readonly socketPath: string) {}

  available(): boolean {
    return existsSync(this.socketPath);
  }

  call<T extends object>(request: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    return new Promise((resolve, reject) => {
      let buf = "";
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new HelperError("timeout", "The desktop helper did not answer in time"))), timeoutMs);
      const conn = connect(this.socketPath, () => conn.write(`${JSON.stringify(request)}\n`));
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        done(() => {
          try {
            const res = JSON.parse(buf.slice(0, nl)) as { ok: boolean; code?: string; error?: string };
            if (res.ok) resolve(res as unknown as T);
            else reject(new HelperError(res.code ?? "failed", res.error ?? "Desktop helper error"));
          } catch {
            reject(new HelperError("failed", "Malformed reply from the desktop helper"));
          }
        });
      });
      conn.on("error", () => done(() => reject(new HelperError("unavailable", "The desktop helper is not running"))));
      conn.on("close", () => done(() => reject(new HelperError("unavailable", "The desktop helper closed the connection"))));
    });
  }
}
