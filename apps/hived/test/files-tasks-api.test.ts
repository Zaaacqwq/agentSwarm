import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app/build-app.ts";
import { cleanFilename, sniffMime } from "../src/files/file-store.ts";
import { schema } from "../src/db/client.ts";
import { buildWorld, callTool } from "./fakes.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe("file helpers", () => {
  test("types come from the bytes, names lose paths", () => {
    expect(sniffMime(PNG, "x.txt")).toBe("image/png");
    expect(sniffMime(new TextEncoder().encode("# hi"), "notes.md")).toBe("text/markdown");
    expect(sniffMime(new TextEncoder().encode("<svg onload=alert(1)>"), "x.svg")).toBe("text/plain");
    expect(sniffMime(Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]), "x.exe")).toBeNull();
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename('..\\evil"<>.txt')).toBe("evil.txt");
    expect(cleanFilename("")).toBe("file");
  });
});

describe("files and tasks over HTTP", () => {
  test("upload, attach, download safely, and agents read text files", async () => {
    const read: string[] = [];
    const w = await buildWorld({
      script: async (input) => {
        for (const [, id] of input.prompt.matchAll(/\((file_[a-f0-9]+)\)/g)) read.push((await callTool(input, "read_file", { file_id: id! })).text);
      },
    });
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    const cookie = `hive_session=${w.token}`;
    const ada = w.makeAgent("Ada");
    const dm = w.chat.openDm(w.user, ada.id);
    const upload = (body: Uint8Array, name: string, channel = dm.id) =>
      app.inject({ method: "POST", url: `/api/channels/${channel}/files`, headers: { cookie, "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) }, payload: Buffer.from(body) });

    const png = (await upload(PNG, "shot.png")).json();
    expect(png).toMatchObject({ mime: "image/png", filename: "shot.png", messageId: null });
    const log = (await upload(new TextEncoder().encode("error: boom\n"), "../build.log")).json();
    expect(log).toMatchObject({ mime: "text/plain", filename: "build.log" });
    expect((await upload(Uint8Array.from([0x4d, 0x5a, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0]), "x.exe")).statusCode).toBe(400);
    expect((await upload(new Uint8Array(10 * 1024 * 1024 + 10).fill(65), "big.txt")).statusCode).toBeGreaterThanOrEqual(400);

    const msg = (await app.inject({ method: "POST", url: `/api/channels/${dm.id}/messages`, headers: { cookie }, payload: { body: "see attached", attachmentIds: [png.id, log.id] } })).json();
    expect(msg.attachments.map((a: { filename: string }) => a.filename).sort()).toEqual(["build.log", "shot.png"]);
    expect((await app.inject({ method: "POST", url: `/api/channels/${dm.id}/messages`, headers: { cookie }, payload: { body: "again", attachmentIds: [png.id] } })).statusCode).toBe(400);
    await w.manager.idle();
    expect(read.join("\n")).toContain("error: boom");
    expect(read.join("\n")).toContain("only text files can be read");

    const inline = await app.inject({ url: `/api/files/${png.id}?inline=1`, headers: { cookie } });
    expect(inline.headers["content-disposition"]).toStartWith("inline");
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");
    const text = await app.inject({ url: `/api/files/${log.id}?inline=1`, headers: { cookie } });
    expect(text.headers["content-disposition"]).toStartWith("attachment");
    expect(text.headers["content-security-policy"]).toContain("sandbox");
    expect(text.body).toBe("error: boom\n");
    expect((await app.inject({ url: `/api/channels/${dm.id}/files`, headers: { cookie } })).json()).toHaveLength(2);
    expect((await app.inject({ url: `/api/files/${png.id}` })).statusCode).toBe(401);

    // Another person without access to this DM cannot fetch its files.
    const hash = await Bun.password.hash("second-user-password", { algorithm: "argon2id" });
    w.handle.db.insert(schema.users).values({ id: "usr_b", orgId: w.user.orgId, username: "bea", passwordHash: hash, role: "member", createdAt: 1 }).run();
    const bea = await w.auth.login({ username: "bea", password: "second-user-password" });
    expect((await app.inject({ url: `/api/files/${png.id}`, headers: { cookie: `hive_session=${bea.token}` } })).statusCode).toBe(404);
    await app.close();
  });

  test("task CRUD, approval and transitions", async () => {
    const w = await buildWorld();
    const app = await buildApp({ services: w, config: { secureCookies: false, webDistDir: null } });
    const cookie = `hive_session=${w.token}`;
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const dev = w.makeAgent("Dev");
    const t = (await call("POST", "/api/tasks", { title: "Ship it", description: "d", acceptance: ["works"], assigneeAgentId: dev.id })).json();
    expect(t).toMatchObject({ number: 1, status: "todo", approved: true, assigneeAgentId: dev.id });
    const t2 = (await call("POST", "/api/tasks", { title: "Second", description: "d", dependsOn: [t.id] })).json();
    expect(t2.dependsOn).toEqual([t.id]);
    expect((await call("PATCH", `/api/tasks/${t2.id}`, { status: "in_progress" })).statusCode).toBe(409);
    expect((await call("PATCH", `/api/tasks/${t.id}`, { status: "done" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/tasks/${t.id}`, { status: "in_progress" })).json().status).toBe("in_progress");
    expect((await call("PATCH", `/api/tasks/${t.id}`, { status: "done" })).json().status).toBe("done");
    expect((await call("PATCH", `/api/tasks/${t2.id}`, { status: "in_progress" })).json().status).toBe("in_progress");
    expect((await call("POST", `/api/tasks/${t.id}/approve`)).statusCode).toBe(409);
    const detail = (await call("GET", `/api/tasks/${t.id}`)).json();
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "updated", "updated"]);
    expect((await call("GET", "/api/channels")).json().filter((c: { kind: string }) => c.kind === "task")).toHaveLength(2);
    expect((await call("DELETE", `/api/tasks/${t2.id}`)).statusCode).toBe(409);
    expect((await call("DELETE", `/api/tasks/${t.id}`)).statusCode).toBe(200);
    await w.manager.idle();
    await app.close();
  });
});
