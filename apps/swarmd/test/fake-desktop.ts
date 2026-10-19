import { HelperError, type DesktopHelper } from "../src/desktop/helper.ts";

/** A 1×1 JPEG, enough for a look. */
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

export interface FakeDesktop extends DesktopHelper {
  /** Every command it got, in order (without the session token). */
  readonly calls: Record<string, unknown>[];
  /** What the helper would see: whether it is installed and granted. */
  installed: boolean;
  granted: boolean;
  /** You press Stop in the menu bar. */
  stopOnMac(): void;
  /** You use the mouse: the agent's input waits until then. */
  pauseFor(ms: number): void;
  /** Clicks the fake treats as landing outside the app under test. */
  outside: Set<number>;
}

/** The helper's rules without a screen: a session token, one app under test, Stop that latches, pauses. */
export function fakeDesktop(): FakeDesktop {
  let armed: { until: number; holder: string; session: string } | null = null;
  let target: string | null = null;
  let stopped = false;
  let pausedUntil = 0;
  const calls: Record<string, unknown>[] = [];
  const fail = (code: string, message: string, extra?: number) => {
    throw new HelperError(code, message, extra ?? null);
  };
  const fake: FakeDesktop = {
    calls, installed: true, granted: true, outside: new Set(),
    stopOnMac() {
      armed = null;
      target = null;
      stopped = true;
    },
    pauseFor(ms) {
      pausedUntil = Date.now() + ms;
    },
    async call<T extends object>(req: Record<string, unknown>): Promise<T> {
      if (!fake.installed) fail("unavailable", "agentSwarm Desktop is not running on this Mac");
      const { session, ...rest } = req;
      calls.push(rest);
      const live = armed && armed.until > Date.now() ? armed : null;
      const status = () => ({
        ok: true, screenRecording: fake.granted, accessibility: fake.granted, watching: true, stoppedByUser: stopped,
        armed: live ? { untilMs: live.until, holder: live.holder, app: target, pausedUntilMs: pausedUntil > Date.now() ? pausedUntil : null } : null,
      });
      switch (req.cmd) {
        case "status": return status() as unknown as T;
        case "arm":
          if (stopped) fail("denied", "You stopped desktop control; it must be approved again");
          armed = { until: Number(req.untilMs), holder: String(req.holder), session: String(session) };
          target = null;
          return status() as unknown as T;
        case "disarm":
          if (!session || session === armed?.session) {
            armed = null;
            target = null;
          }
          return status() as unknown as T;
        case "ack_stop":
          stopped = false;
          return status() as unknown as T;
        default:
          break;
      }
      if (!live || session !== live.session) fail("denied", "No approved desktop session is active");
      if (req.cmd === "open") {
        if (pausedUntil > Date.now()) fail("paused", "The person is using this Mac", pausedUntil);
        if (!String(req.path).endsWith(".app")) fail("bad_request", "open needs the path of a .app");
        target = "Demo";
        return { ok: true, pid: 4321, name: "Demo", inFront: true } as unknown as T;
      }
      if (!target) fail("bad_request", "No app is open yet; open it first (desktop_open)");
      if (req.cmd === "look") return { ok: true, image: JPEG, width: 640, height: 400, ui: "[1] Button \"New Note\" @40,20\n[2] TextArea", inFront: true } as unknown as T;
      if (req.cmd === "focus" || req.cmd === "close") return { ok: true, inFront: true } as unknown as T;
      if (pausedUntil > Date.now()) fail("paused", "The person is using this Mac", pausedUntil);
      if (req.cmd === "key" && /cmd\+tab/i.test(String(req.combo))) fail("denied", "cmd+tab is off limits to agents");
      if (req.cmd === "click" && fake.outside.has(Number(req.x))) fail("denied", "That is Finder, not the app under test: only the app under test can be used");
      return { ok: true, inFront: true } as unknown as T;
    },
  };
  return fake;
}
