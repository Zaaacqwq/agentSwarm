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

  /**
   * Resolves only once the socket is fully closed. Returning while Bun still owed the socket its
   * close let a following Bun.spawn reuse that file descriptor, which the late close then shut,
   * crashing Bun 1.3.0 (seen at hived startup: disarm, then the first hive-exec spawn).
   */
  call<T extends object>(request: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let outcome: { ok: true; value: T } | { ok: false; error: HelperError } | null = null;
      let finished = false;
      let socket: { end(): void } | null = null;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const o = outcome ?? { ok: false as const, error: new HelperError("unavailable", "The desktop helper closed the connection") };
        if (o.ok) resolve(o.value);
        else reject(o.error);
      };
      const settle = (o: NonNullable<typeof outcome>): void => {
        outcome ??= o;
        if (socket) socket.end();
        else finish();
      };
      const timer = setTimeout(() => {
        outcome ??= { ok: false, error: new HelperError("timeout", "The desktop helper did not answer in time") };
        socket?.end();
        // If the close never arrives, give up waiting for it too.
        setTimeout(finish, 1000);
      }, timeoutMs);
      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            socket = s;
            s.write(`${JSON.stringify(request)}\n`);
          },
          data(_s, chunk) {
            chunks.push(Buffer.from(chunk));
            const buf = Buffer.concat(chunks).toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0 || outcome) return;
            try {
              const res = JSON.parse(buf.slice(0, nl)) as { ok: boolean; code?: string; error?: string };
              settle(res.ok ? { ok: true, value: res as unknown as T } : { ok: false, error: new HelperError(res.code ?? "failed", res.error ?? "Desktop helper error") });
            } catch {
              settle({ ok: false, error: new HelperError("failed", "Malformed reply from the desktop helper") });
            }
          },
          close() {
            // Bun finishes closing the descriptor after this callback; let that happen first.
            setTimeout(finish, 1);
          },
          error() {
            outcome ??= { ok: false, error: new HelperError("unavailable", "The desktop helper is not running") };
          },
          connectError() {
            outcome ??= { ok: false, error: new HelperError("unavailable", "The desktop helper is not running") };
            finish();
          },
        },
      }).catch(() => {
        outcome ??= { ok: false, error: new HelperError("unavailable", "The desktop helper is not running") };
        finish();
      });
    });
  }
}
