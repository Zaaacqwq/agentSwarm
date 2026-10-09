import { afterAll, describe, expect, test } from "bun:test";
import type { AgentContext } from "@hive/tools";
import type { AuthUser } from "../src/auth/auth-service.ts";
import { DESKTOP_RESOURCE } from "../src/desktop/desktop-service.ts";
import { HelperError, type DesktopHelper } from "../src/desktop/desktop-helper.ts";
import { browserRuntime } from "../../../packages/priv-helper/test/browser-runtime.ts";
import { buildWorld, callTool, channelOf } from "./fakes.ts";
import { localBackend } from "./local-backend.ts";

type World = Awaited<ReturnType<typeof buildWorld>>;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString("base64");

/** Stands in for Hive Desktop: records commands and enforces arming like the real helper. */
class FakeHelper implements DesktopHelper {
  readonly calls: Record<string, unknown>[] = [];
  armed: { untilMs: number; holder: string } | null = null;
  available(): boolean {
    return true;
  }
  async call<T extends object>(req: Record<string, unknown>): Promise<T> {
    this.calls.push(req);
    const front = { frontmost: { app: "TextEdit", title: "Untitled" } };
    switch (req.cmd) {
      case "status":
        return { screenRecording: true, accessibility: true, armed: this.armed, stoppedByUser: false, displays: [{ index: 0, width: 2560, height: 1440, imageWidth: 1280, imageHeight: 720, main: true }], ...front } as T;
      case "arm":
        this.armed = { untilMs: req.untilMs as number, holder: req.holder as string };
        return {} as T;
      case "disarm":
        this.armed = null;
        return {} as T;
      case "screenshot":
        return { image: JPEG, width: 1280, height: 720, display: 0, ...front } as T;
      default:
        if (!this.armed) throw new HelperError("denied", "No approved desktop control session is active");
        if (req.cmd === "ui") return { text: '[1] Button "Save" @d0:640,400', app: "TextEdit" } as T;
        return front as T;
    }
  }
}

/** Answers every new request the moment it appears, as a person would in the UI. */
function autoDecide(w: World, decide: (a: { kind: string; question: string }) => { decision: "approve" | "deny"; answer?: string; minutes?: number } | null) {
  return w.bus.subscribe(({ event }) => {
    if (event.type !== "approval.updated" || event.approval.status !== "pending") return;
    const choice = decide(event.approval);
    if (choice) setTimeout(() => w.approvals.decide(w.user, event.approval.id, choice), 5);
  });
}

const ctxOf = (w: World, agentId: string): AgentContext => ({ agentId, orgId: w.user.orgId, runId: "run_manual", grants: [], currentGrants: () => [] });

describe("ask_human", () => {
  test("blocks until a person answers, with a card in the chat", async () => {
    const results: string[] = [];
    const w = await buildWorld({
      script: async (input) => {
        results.push((await callTool(input, "ask_human", { question: "Deploy to staging now?", options: ["Yes", "No"] })).text);
      },
    });
    const agent = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, agent.id);
    let sawWaiting = false;
    w.bus.subscribe(({ event }) => {
      if (event.type === "agent.state" && event.queue?.waitingFor?.startsWith("an answer: Deploy")) sawWaiting = true;
      if (event.type === "approval.updated" && event.approval.status === "pending") {
        expect(() => w.approvals.decide(w.user, event.approval.id, { decision: "approve" })).toThrow("Pick an option");
        setTimeout(() => w.approvals.decide(w.user, event.approval.id, { decision: "approve", answer: "Yes" }), 5);
      }
    });
    w.chat.postUserMessage(w.user, dm.id, "ship it?");
    await w.manager.idle();
    expect(results).toEqual(["admin answered: Yes"]);
    expect(sawWaiting).toBe(true);
    const bodies = w.chat.listMessages(w.user, dm.id, {}).messages.map((m) => m.body);
    expect(bodies.some((b) => b.startsWith("❓ Ada asks: Deploy to staging now?"))).toBe(true);
    const [approval] = w.approvals.list(w.user, { channelId: dm.id });
    expect(approval).toMatchObject({ kind: "question", status: "approved", answer: "Yes", decidedBy: "admin" });
    expect(approval!.messageId).not.toBeNull();
  });

  test("lapses when nobody answers", async () => {
    const results: string[] = [];
    const w = await buildWorld({
      approvalTimeoutMs: 100,
      script: async (input) => {
        results.push((await callTool(input, "ask_human", { question: "Anyone there?" })).text);
      },
    });
    const agent = w.makeAgent("Ada");
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "hello");
    await w.manager.idle();
    expect(results).toEqual(["No one answered within 10 minutes."]);
    expect(w.approvals.list(w.user, {})[0]?.status).toBe("expired");
  });
});

describe("desktop control sessions", () => {
  test("needs an approved session and the lease; ends with the run, can be revoked", async () => {
    const helper = new FakeHelper();
    const out: string[] = [];
    let step = 0;
    const w = await buildWorld({
      desktopHelper: helper,
      script: async (input) => {
        const call = async (name: string, args: Record<string, unknown> = {}) => out.push(`${name}: ${(await callTool(input, name, args)).text}`);
        if (step++ === 0) {
          await call("desktop_click", { x: 10, y: 10 });
          await call("desktop_acquire", { reason: "Fill in the TextEdit document", minutes: 5 });
          expect(w.leases.current(DESKTOP_RESOURCE)?.holderAgentId).toBe(input.agent.id);
          expect(helper.armed?.holder).toBe("Ada");
          await call("desktop_screenshot");
          await call("desktop_ui");
          await call("desktop_click", { x: 640, y: 400 });
        } else {
          await call("desktop_type", { text: "hello" });
          await call("desktop_acquire", { reason: "Continue the document" });
          await call("desktop_type", { text: "hello" });
          // A second agent cannot take the desktop while Ada holds it.
          const bob = w.agents.list(w.user).find((a) => a.name === "Bob")!;
          await expect(w.desktop.acquire(ctxOf(w, bob.id), "Bob wants it", 5)).rejects.toThrow("Ada is using the desktop");
        }
      },
    });
    await w.registry.refreshHealth();
    const grants = [{ toolpackId: "core.communication", toolName: "*" }, { toolpackId: "core.desktop", toolName: "*" }];
    const ada = w.makeAgent("Ada", grants);
    w.makeAgent("Bob", grants);
    const off = autoDecide(w, () => ({ decision: "approve", minutes: 5 }));
    const dm = w.chat.openDm(w.user, ada.id);

    w.chat.postUserMessage(w.user, dm.id, "please edit the doc");
    await w.manager.idle();
    expect(out[0]).toContain("do not hold the desktop");
    expect(out[1]).toContain("Desktop control approved by admin until");
    expect(out[2]).toContain("Display 0: 1280×720 screenshot attached");
    expect(out[3]).toContain('Button "Save"');
    expect(out[4]).toContain("Clicked (640, 400)");
    const arm = helper.calls.find((c) => c.cmd === "arm")!;
    expect(arm.untilMs as number).toBeGreaterThan(Date.now() + 4 * 60_000);
    // The run ended, so the lease went back and the helper was disarmed.
    expect(w.leases.current(DESKTOP_RESOURCE)).toBeNull();
    expect(helper.armed).toBeNull();
    const shots = w.screenshots.listForAgent(w.user.orgId, ada.id);
    expect(shots).toHaveLength(1);
    const run = w.runs.listRuns(w.user.orgId, ada.id)[0]!;
    expect(w.runs.listActivity([run.id]).some((a) => a.kind === "tool_result" && a.payload.screenshotId === shots[0]!.id)).toBe(true);

    // Next turn: the approval is still valid, so acquiring again needs no new request.
    const pendingBefore = w.approvals.list(w.user, {}).length;
    w.chat.postUserMessage(w.user, dm.id, "continue");
    await w.manager.idle();
    expect(out[5]).toContain("do not hold the desktop");
    expect(out[6]).toContain("Desktop control approved");
    expect(out[7]).toContain("Typed 5 characters");
    expect(w.approvals.list(w.user, {}).length).toBe(pendingBefore);
    off();

    // Members cannot grant desktop control; the stop button revokes the session.
    const member: AuthUser = { ...w.user, id: "usr_member", username: "member", role: "member" };
    const active = w.approvals.list(w.user, { status: "active" })[0]!;
    expect(() => w.approvals.decide(member, active.id, { decision: "approve" })).toThrow();
    w.approvals.revoke(w.user, active.id);
    expect(w.approvals.active(ada.id, "desktop", "console")).toBeNull();
    await expect(w.desktop.act(ctxOf(w, ada.id), { cmd: "click", x: 1, y: 1 })).rejects.toThrow("do not hold the desktop");
  });

  test("a denied request leaves the desktop untouched", async () => {
    const helper = new FakeHelper();
    const w = await buildWorld({ desktopHelper: helper });
    const ada = w.makeAgent("Ada");
    autoDecide(w, () => ({ decision: "deny" }));
    await expect(w.desktop.acquire(ctxOf(w, ada.id), "Rearrange windows", 5)).rejects.toThrow("admin declined");
    expect(helper.armed).toBeNull();
    expect(w.leases.current(DESKTOP_RESOURCE)).toBeNull();
  });
});

describe("agent browser", () => {
  const posts: string[] = [];
  const site = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") {
        posts.push(await req.text());
        return new Response("<h1>Welcome back</h1>", { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/login") {
        return new Response('<title>Sign in</title><form method="post"><label>Password <input type="password" name="p"></label><button type="submit">Sign in</button></form>', { headers: { "content-type": "text/html" } });
      }
      return new Response('<title>Shop admin</title><h1>Admin</h1><a href="/login">Login</a><p>Orders today: 42</p>', { headers: { "content-type": "text/html" } });
    },
  });
  afterAll(() => site.stop(true));

  test("reads freely; form posts wait for a person's approval of that site", async () => {
    const runtime = await browserRuntime();
    // Short paths: Unix socket names are limited to 104 bytes on macOS.
    const { backend } = localBackend(true, "/tmp", { ...runtime, browserAllowHosts: ["127.0.0.1"] });
    const base = `http://127.0.0.1:${site.port}`;
    const out: string[] = [];
    const w = await buildWorld({
      backend,
      script: async (input) => {
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const r = await callTool(input, name, args);
          out.push(`${name}: ${r.text}`);
          return r.text;
        };
        const ref = (text: string, re: RegExp) => re.exec(text)?.[1];
        const home = await call("browser_open", { url: base });
        expect(home).toContain("Shop admin");
        const snap = await call("browser_snapshot");
        expect(snap).toContain("Orders today: 42");
        await call("browser_click", { ref: ref(snap, /link "Login" \[ref=(\w+)\]/) });
        expect(await call("browser_screenshot", { post_to: channelOf(input), caption: "The sign-in page" })).toContain("Posted it in");
        const form = await call("browser_snapshot");
        const blocked = await call("browser_click", { ref: ref(form, /button "Sign in" \[ref=(\w+)\]/) });
        expect(blocked).toContain("approved writes on 127.0.0.1");
        expect(posts).toHaveLength(0);
        await call("browser_open", { url: `${base}/login` });
        const again = await call("browser_snapshot");
        await call("browser_type", { ref: ref(again, /textbox "Password" \[ref=(\w+)\]/), text: "s3cret" });
        const done = await call("browser_click", { ref: ref(again, /button "Sign in" \[ref=(\w+)\]/) });
        expect(done).toContain(base);
        expect((await call("browser_open", { url: "http://10.1.2.3/" }))).toMatch(/private/i);
      },
    });
    const ws = await w.workstations.create(w.user, { name: "Bench", osUser: "ws-1" });
    await w.registry.refreshHealth();
    const agent = w.makeAgent("Op", [{ toolpackId: "core.communication", toolName: "*" }, { toolpackId: "core.browser", toolName: "*" }]);
    w.workstations.bind(w.user, agent.id, ws.id);
    const asked: string[] = [];
    autoDecide(w, (a) => {
      asked.push(`${a.kind}: ${a.question}`);
      return { decision: "approve" };
    });
    const dm = w.chat.openDm(w.user, agent.id);
    w.chat.postUserMessage(w.user, dm.id, "check today's orders");
    await w.manager.idle();
    const shared = w.chat.listMessages(w.user, dm.id, {}).messages.find((m) => m.attachments.length > 0);
    expect(shared).toMatchObject({ body: "The sign-in page", attachments: [{ mime: "image/jpeg" }] });
    const run = w.runs.listRuns(w.user.orgId, agent.id)[0]!;
    expect(run.status, out.join("\n")).toBe("succeeded");
    expect(asked).toEqual(["browser_site: submitting a form on 127.0.0.1"]);
    expect(posts).toEqual(["p=s3cret"]);
    expect(w.screenshots.listForAgent(w.user.orgId, agent.id)).toHaveLength(1);
    expect(w.browser.profile(agent.id)).not.toBeNull();
    await w.browser.reset(agent.id);
    expect(w.browser.profile(agent.id)).toBeNull();
  }, 120_000);
});

describe("approval and desktop HTTP API", () => {
  test("list, decide, live view, stop, screenshots", async () => {
    const { buildApp } = await import("../src/app/build-app.ts");
    const helper = new FakeHelper();
    const w = await buildWorld({ desktopHelper: helper });
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    const cookie = `hive_session=${w.token}`;
    const ada = w.makeAgent("Ada");

    const pending = w.desktop.acquire(ctxOf(w, ada.id), "Check the build window", 10);
    await Bun.sleep(10);
    const list = (await app.inject({ method: "GET", url: "/api/approvals?status=pending", headers: { cookie } })).json() as { id: string; kind: string }[];
    expect(list).toMatchObject([{ kind: "desktop", agentName: "Ada", durationMs: 600_000 }]);
    const decided = await app.inject({ method: "POST", url: `/api/approvals/${list[0]!.id}/decide`, headers: { cookie }, payload: { decision: "approve", minutes: 3 } });
    expect(decided.json()).toMatchObject({ status: "approved", durationMs: 180_000 });
    expect(await pending).toContain("approved by admin");
    expect((await app.inject({ method: "POST", url: `/api/approvals/${list[0]!.id}/decide`, headers: { cookie }, payload: { decision: "deny" } })).statusCode).toBe(400);

    const status = (await app.inject({ method: "GET", url: "/api/desktop", headers: { cookie } })).json();
    expect(status).toMatchObject({ available: true, screenRecording: true, holder: { agentName: "Ada" } });
    const screen = await app.inject({ method: "GET", url: "/api/desktop/screen", headers: { cookie } });
    expect(screen.headers["content-type"]).toBe("image/jpeg");
    expect(screen.headers["cache-control"]).toBe("no-store");
    expect(helper.calls.find((c) => c.cmd === "screenshot")).toMatchObject({ grid: false });

    const shot = await w.desktop.act(ctxOf(w, ada.id), { cmd: "screenshot" });
    const img = await app.inject({ method: "GET", url: `/api/screenshots/${shot.screenshot!.id}`, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/agents/${ada.id}/screenshots`, headers: { cookie } })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/desktop/screen" })).statusCode).toBe(401);

    expect((await app.inject({ method: "POST", url: "/api/desktop/stop", headers: { cookie } })).json<{ ok: boolean }>()).toEqual({ ok: true });
    expect(helper.armed).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/approvals?status=active", headers: { cookie } })).json<unknown[]>()).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/agents/${ada.id}/browser`, headers: { cookie } })).json()).toMatchObject({ exists: false, siteApprovals: [] });
  });
});
