import { afterAll, describe, expect, test } from "bun:test";
import { dispatch } from "../src/dispatch.ts";
import { checkUrl, hostApproved, isBlockedAddress } from "../src/browser/url-guard.ts";
import type { BrowserResponse, Response } from "../src/index.ts";
import { fixture } from "./fixture.ts";
import { browserRuntime } from "./browser-runtime.ts";

describe("url guard", () => {
  test("blocks local, private and non-http targets, including via DNS", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress("93.184.215.14")).toBe(false);
    expect(await checkUrl("file:///etc/passwd")).toMatchObject({ ok: false });
    expect(await checkUrl("http://localhost:4318/api")).toMatchObject({ ok: false });
    expect(await checkUrl("http://rebind.example/", async () => ["127.0.0.1"])).toMatchObject({ ok: false });
    expect(await checkUrl("https://good.example/", async () => ["93.184.215.14"])).toEqual({ ok: true, host: "good.example" });
    expect(await checkUrl("http://127.0.0.1:9/", undefined, ["127.0.0.1"])).toEqual({ ok: true, host: "127.0.0.1" });
    expect(hostApproved("www.example.com", ["example.com"])).toBe(true);
    expect(hostApproved("evilexample.com", ["example.com"])).toBe(false);
  });
});

// A real headless Chrome as the "workstation user", sandboxed, against a local test site.
describe("browser daemon via hive-exec", () => {
  const posts: string[] = [];
  const site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") {
        posts.push(await req.text());
        return new Response("<h1>Saved</h1>", { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/login") {
        return new Response('<form method="post"><label>User <input name="u"></label><label>Password <input type="password" name="p"></label><button type="submit">Sign in</button></form>', { headers: { "content-type": "text/html" } });
      }
      return new Response('<h1>Admin</h1><a href="/login">Login</a><p>Orders today: 42</p>', { headers: { "content-type": "text/html" } });
    },
  });
  afterAll(() => site.stop(true));

  test("open, snapshot, click, screenshot; writes need approval", async () => {
    const runtime = await browserRuntime();
    // Unix socket paths are limited to 104 bytes, so use a short base under /tmp.
    const f = fixture(true, "/tmp");
    const env = { ...f.env, layout: { ...f.layout, ...runtime, browserAllowHosts: ["127.0.0.1"] } };
    const call = async (command: object, approvedHosts: string[] = []) => {
      const r: Response = await dispatch(env, { op: "browser", agent: "agt_test", request: { command: command as never, approvedHosts } });
      if (!r.ok) throw new Error(r.error);
      return r.result as BrowserResponse;
    };
    const base = `http://127.0.0.1:${site.port}`;
    expect(await call({ cmd: "open", url: base })).toMatchObject({ ok: true, title: "" });
    const snap = await call({ cmd: "snapshot" });
    expect(snap.ok && snap.text).toContain("Orders today: 42");
    const ref = /link "Login" \[ref=(\w+)\]/.exec(snap.ok ? snap.text! : "")?.[1];
    expect(ref).toBeTruthy();
    expect(await call({ cmd: "click", ref })).toMatchObject({ ok: true, url: `${base}/login` });
    const shot = await call({ cmd: "screenshot" });
    expect(shot.ok && shot.image!.length).toBeGreaterThan(1000);
    expect(shot).toMatchObject({ width: 1280, height: 800 });
    expect(await call({ cmd: "screenshot", full: true })).toMatchObject({ ok: true, width: 1280 });

    const form = await call({ cmd: "snapshot" });
    const pass = /textbox "Password" \[ref=(\w+)\]/.exec(form.ok ? form.text! : "")?.[1];
    const submit = /button "Sign in" \[ref=(\w+)\]/.exec(form.ok ? form.text! : "")?.[1];
    expect(await call({ cmd: "type", ref: pass, text: "secret" })).toMatchObject({ ok: false, needsApproval: { host: "127.0.0.1" } });
    const blocked = await call({ cmd: "click", ref: submit });
    expect(blocked).toMatchObject({ ok: true, blockedWrites: ["POST 127.0.0.1"], blockedSite: "127.0.0.1" });
    expect(posts).toHaveLength(0);
    // The blocked navigation leaves an error page; with approval the agent reopens the form.
    await call({ cmd: "open", url: `${base}/login` });
    const again = await call({ cmd: "snapshot" });
    const pass2 = /textbox "Password" \[ref=(\w+)\]/.exec(again.ok ? again.text! : "")?.[1];
    const submit2 = /button "Sign in" \[ref=(\w+)\]/.exec(again.ok ? again.text! : "")?.[1];
    expect(await call({ cmd: "type", ref: pass2, text: "secret" }, ["127.0.0.1"])).toMatchObject({ ok: true });
    expect(await call({ cmd: "click", ref: submit2 }, ["127.0.0.1"])).toMatchObject({ ok: true });
    expect(posts[0]).toContain("p=secret");

    expect(await call({ cmd: "open", url: "file:///etc/passwd" })).toMatchObject({ ok: false });
    expect(await call({ cmd: "open", url: "http://10.0.0.1/" })).toMatchObject({ ok: false });
    const reset = await dispatch(env, { op: "browser.reset", agent: "agt_test" });
    expect(reset).toMatchObject({ ok: true });
    expect(await dispatch(env, { op: "browser", agent: "../evil", request: { command: { cmd: "ping" }, approvedHosts: [] } })).toMatchObject({ ok: false, code: "bad_request" });
  }, 120_000);
});
