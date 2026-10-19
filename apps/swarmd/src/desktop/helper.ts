import { connect } from "node:net";

/** What the helper answers to `status`. */
export interface HelperStatus {
  readonly screenRecording: boolean;
  readonly accessibility: boolean;
  readonly watching: boolean;
  readonly stoppedByUser: boolean;
  readonly armed: { readonly untilMs: number; readonly holder: string; readonly app: string | null; readonly pausedUntilMs: number | null } | null;
}

export class HelperError extends Error {
  readonly code: string;
  /** For "paused": when the person's pause ends, as far as the helper knows. */
  readonly pausedUntilMs: number | null;

  constructor(code: string, message: string, pausedUntilMs: number | null = null) {
    super(message);
    this.code = code;
    this.pausedUntilMs = pausedUntilMs;
  }
}

/** agentSwarm Desktop, the LaunchAgent in your GUI session (native/desktop). Tests use a fake. */
export interface DesktopHelper {
  call<T extends object>(request: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

/** One JSON line out, one JSON line back, over the helper's 0600 Unix socket. */
export class SocketHelper implements DesktopHelper {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  call<T extends object>(request: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (error: HelperError | null, value?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => finish(new HelperError("timeout", "agentSwarm Desktop did not answer in time")), timeoutMs);
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        const nl = text.indexOf("\n");
        if (nl < 0) return;
        try {
          const res = JSON.parse(text.slice(0, nl)) as { ok: boolean; code?: string; error?: string; pausedUntilMs?: number };
          if (res.ok) finish(null, res as unknown as T);
          else finish(new HelperError(res.code ?? "failed", res.error ?? "agentSwarm Desktop failed", res.pausedUntilMs ?? null));
        } catch {
          finish(new HelperError("failed", "agentSwarm Desktop sent a malformed reply"));
        }
      });
      socket.on("error", () => finish(new HelperError("unavailable", "agentSwarm Desktop is not running on this Mac (zsh scripts/setup-desktop.sh)")));
      socket.on("close", () => finish(new HelperError("unavailable", "agentSwarm Desktop closed the connection")));
    });
  }
}
