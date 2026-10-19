import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {
  CreateAgent, CreateEndpoint, CreateMission, CreateProject, CreateRun, Credentials, MissionBudget, MissionReply, RunMessage, SetCli, SetDiscord, SetGitHubToken, SetProjectProfile, PutProjectFile, CreateLocalProject, MachineSettings, ModelSettings, CreateTicket, UpdateTicket, MoveTicket, TicketSettings, PromoteTicket, SendBack, RetryTicket, CreateLesson, UpdateLesson, SetHandbook, DecideProposal, ROLES, type Role, type Me,
} from "@agentswarm/contracts";
import type { Services } from "../app/services.ts";
import { RateLimiter } from "../auth/rate-limit.ts";
import { SESSION_TTL_MS } from "../auth/auth-service.ts";
import { HttpError, badRequest, forbidden, unauthorized } from "../errors.ts";
import { MAX_UPLOAD_BYTES } from "../tickets/attachments.ts";
import { systemCheck, type CheckOptions } from "../system/system-check.ts";

export const SESSION_COOKIE = "swarm_session";
const PUBLIC = new Set(["/api/health", "/api/setup", "/api/auth/login"]);

export interface AppOptions {
  readonly services: Services;
  readonly webDist: string | null;
  readonly check: CheckOptions;
  /** Host headers the dashboard answers to (DNS rebinding); Origins must match one of them. */
  readonly allowedHosts: readonly string[];
  readonly logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    me: Me | null;
  }
}

function sameSite(origin: string, hosts: ReadonlySet<string>): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && hosts.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export async function buildApp(o: AppOptions): Promise<FastifyInstance> {
  const s = o.services;
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: false });
  // Ticket pictures arrive as raw bytes (R7); only that route accepts a body this large.
  app.addContentTypeParser(["image/jpeg", "image/png", "image/heic", "image/heif", "application/octet-stream"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  await app.register(cookie);
  await app.register(websocket);
  app.decorateRequest("me", null);
  const failedLogins = new RateLimiter(10, 15 * 60_000);
  const hosts = new Set(o.allowedHosts.map((h) => h.toLowerCase()));

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (!req.url.startsWith("/api/")) return;
    // DNS rebinding and cross-site WebSockets: only known hosts, and only same-origin pages.
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) throw forbidden("Unknown host");
    // Same origin only: a page served on one of the known hosts (over http, or https through Tailscale serve).
    const origin = req.headers.origin;
    if (origin && !sameSite(origin, hosts)) throw forbidden("Cross-origin request refused");
    // CSRF: state changes must be JSON (forms cannot send JSON cross-site).
    if (req.method !== "GET" && req.method !== "HEAD") {
      const type = String(req.headers["content-type"] ?? "");
      // A ticket's picture is sent as itself: a type no form can send, and that a cross-site fetch would have to preflight.
      const picture = /^\/api\/tickets\/[^/]+\/attachments(\?|$)/.test(req.url) && /^(image\/(jpeg|png|heic|heif)|application\/octet-stream)$/.test(type);
      if (req.headers["content-length"] !== "0" && req.headers["content-length"] !== undefined && !type.startsWith("application/json") && !picture) {
        throw new HttpError(415, "Send JSON");
      }
    }
    req.me = s.auth.resolve(req.cookies[SESSION_COOKIE]);
    const path = req.url.split("?")[0] ?? "";
    if (!req.me && !PUBLIC.has(path)) throw unauthorized();
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    if (error.validation) return reply.status(400).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send({ error: error.message });
    req.log.error(error);
    return reply.status(500).send({ error: "Internal error" });
  });

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: SESSION_TTL_MS / 1000 });
  const actor = (req: FastifyRequest) => req.me?.id ?? "anonymous";

  // ---- auth ---------------------------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/setup", async () => ({ required: s.auth.isSetupRequired() }));
  app.post<{ Body: Credentials }>("/api/setup", { schema: { body: Credentials } }, async (req, reply) => {
    const session = await s.auth.setup(req.body);
    setSession(reply, session.token);
    return session.user;
  });
  app.post<{ Body: Credentials }>("/api/auth/login", { schema: { body: Credentials } }, async (req, reply) => {
    const key = `${req.ip}|${req.body.username}`;
    if (failedLogins.blocked(key)) throw new HttpError(429, "Too many failed attempts; wait a few minutes");
    const session = await s.auth.login(req.body).catch((error: Error) => {
      failedLogins.hit(key);
      throw error;
    });
    setSession(reply, session.token);
    return session.user;
  });
  app.post("/api/auth/logout", async (req, reply) => {
    s.auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => req.me);

  // ---- endpoints and models -----------------------------------------------------------------
  app.get("/api/endpoints", async () => s.endpoints.list());
  app.post<{ Body: CreateEndpoint }>("/api/endpoints", { schema: { body: CreateEndpoint } }, async (req) => s.endpoints.create(actor(req), req.body));
  app.delete<{ Params: { id: string } }>("/api/endpoints/:id", async (req) => {
    s.endpoints.delete(actor(req), req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/endpoints/:id/models", async (req) => s.gateway.listModels(req.params.id));

  // ---- GitHub and projects ------------------------------------------------------------------
  app.get("/api/github", async () => s.github.status());
  app.put<{ Body: SetGitHubToken }>("/api/github", { schema: { body: SetGitHubToken } }, async (req) => s.github.setToken(actor(req), req.body.token));
  // Repositories to pick a project from: the account's, minus the ones that are projects already.
  app.get("/api/github/repos", async () => {
    const taken = new Set(s.projects.list().map((p) => p.githubRepo.toLowerCase()));
    return (await s.github.client.listRepos(await s.github.token())).filter((r) => !taken.has(r.fullName.toLowerCase()));
  });
  app.get("/api/projects", async () => s.projects.list());
  app.post<{ Body: CreateProject }>("/api/projects", { schema: { body: CreateProject } }, async (req) => s.projects.create(actor(req), req.body));
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => s.projects.view(req.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/refresh", async (req) => s.projects.refresh(req.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/protect", async (req) => ({ protected: await s.projects.ensureProtected(req.params.id) }));
  app.get<{ Params: { id: string } }>("/api/projects/:id/pushes", async (req) => s.relay.history(req.params.id));
  // R5: local projects, profiles, local files, documents of local projects.
  app.post<{ Body: CreateLocalProject }>("/api/projects/local", { schema: { body: CreateLocalProject } }, async (req) => s.projects.createLocal(actor(req), req.body.name));
  app.put<{ Params: { id: string }; Body: SetProjectProfile }>("/api/projects/:id/profile", { schema: { body: SetProjectProfile } }, async (req) => s.projects.setProfile(actor(req), req.params.id, req.body));
  app.put<{ Params: { id: string }; Body: PutProjectFile }>("/api/projects/:id/files", { schema: { body: PutProjectFile } }, async (req) => s.projects.putFile(actor(req), req.params.id, req.body));
  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/files", async (req) => s.projects.deleteFile(actor(req), req.params.id, String(req.query.path ?? "")));
  app.get<{ Params: { id: string }; Querystring: { ref?: string; path?: string } }>("/api/projects/:id/blob", async (req, reply) => {
    const text = await s.projects.blob(req.params.id, String(req.query.ref ?? ""), String(req.query.path ?? ""));
    // Shown as text, never rendered: an agent wrote it.
    return reply.type("text/plain; charset=utf-8").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; sandbox").send(text);
  });
  // R9: desktop sessions. You approve, deny and stop; agents ask through their tools.
  app.get("/api/desktop", async () => {
    await s.desktop.refresh();
    return s.desktop.view();
  });
  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/approve", async (req) => s.desktop.approve(actor(req), req.params.id));
  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/deny", async (req) => s.desktop.deny(actor(req), req.params.id));
  app.post("/api/desktop/stop", async (req) => s.desktop.stop(actor(req)));
  app.get("/api/models/settings", async () => s.backupModel.get());
  app.put<{ Body: ModelSettings }>("/api/models/settings", { schema: { body: ModelSettings } }, async (req) => s.backupModel.set(actor(req), req.body));
  app.get("/api/machine", async () => s.machine.get());
  app.get("/api/machine/load", async () => s.runs.load());
  app.put<{ Body: MachineSettings }>("/api/machine", { schema: { body: MachineSettings } }, async (req) => s.machine.set(actor(req), req.body));

  // ---- workstations and system --------------------------------------------------------------
  app.get("/api/workstations", async () => s.pool.list());
  app.post("/api/workstations/check", async () => s.pool.sync());
  app.get("/api/system", async () => systemCheck(s, o.check));

  // ---- agents and runs ----------------------------------------------------------------------
  app.get<{ Querystring: { projectId?: string } }>("/api/agents", async (req) => s.agents.list(req.query.projectId));
  app.post<{ Body: CreateAgent }>("/api/agents", { schema: { body: CreateAgent } }, async (req) => s.agents.create(actor(req), req.body));
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req) => s.agents.view(req.params.id));
  app.post<{ Params: { id: string }; Body: CreateRun }>("/api/agents/:id/runs", { schema: { body: CreateRun } }, async (req) => s.runs.create(actor(req), req.params.id, req.body));
  app.get<{ Querystring: { agentId?: string; projectId?: string } }>("/api/runs", async (req) => s.runs.list({
    ...(req.query.agentId ? { agentId: req.query.agentId } : {}), ...(req.query.projectId ? { projectId: req.query.projectId } : {}),
  }));
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => s.runs.view(req.params.id));
  app.get<{ Params: { id: string } }>("/api/trees/:id", async (req) => s.runs.tree(req.params.id));
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/trees/:id/events", async (req) => s.runs.treeEvents(req.params.id, Number(req.query.before ?? 0) || null));
  app.get<{ Params: { id: string; file: string } }>("/api/runs/:id/screens/:file", async (req, reply) => {
    const image = s.runs.screen(req.params.id, req.params.file);
    if (!image) return reply.code(404).send({ error: "No such screenshot" });
    return reply.type("image/jpeg").header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=86400").send(image);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (req) => s.runs.events(req.params.id, Number(req.query.after ?? 0) || 0));
  app.post<{ Params: { id: string }; Body: RunMessage }>("/api/runs/:id/messages", { schema: { body: RunMessage } }, async (req) => s.runs.message(actor(req), req.params.id, req.body.text));
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => s.runs.cancel(actor(req), req.params.id));

  // ---- missions -----------------------------------------------------------------------------
  // ---- the team's memory (R8) ----
  const role = (r: string): Role => {
    if (!(ROLES as readonly string[]).includes(r)) throw badRequest("No such role");
    return r as Role;
  };
  app.get("/api/lessons", async () => s.lessons.list());
  app.post<{ Body: CreateLesson }>("/api/lessons", { schema: { body: CreateLesson } }, async (req) => s.lessons.write(req.body));
  app.patch<{ Params: { id: string }; Body: UpdateLesson }>("/api/lessons/:id", { schema: { body: UpdateLesson } }, async (req) => s.lessons.update(actor(req), req.params.id, req.body));
  app.delete<{ Params: { id: string } }>("/api/lessons/:id", async (req, reply) => {
    s.lessons.remove(actor(req), req.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/lessons/:id/versions", async (req) => s.lessons.versions(req.params.id));
  app.get("/api/handbooks", async () => ROLES.map((r) => s.handbooks.view(r)));
  app.put<{ Params: { role: string }; Body: SetHandbook }>("/api/handbooks/:role", { schema: { body: SetHandbook } }, async (req) => s.handbooks.set(actor(req), role(req.params.role), req.body.text));
  app.get<{ Params: { role: string; id: string } }>("/api/handbooks/:role/versions/:id", async (req) => ({ text: s.handbooks.versionText(role(req.params.role), Number(req.params.id)) }));
  app.post<{ Params: { role: string; id: string } }>("/api/handbooks/:role/versions/:id/restore", async (req) => s.handbooks.restore(actor(req), role(req.params.role), Number(req.params.id)));
  app.get<{ Querystring: { status?: string } }>("/api/handbook-proposals", async (req) => s.handbooks.proposals(["open", "accepted", "rejected"].includes(req.query.status ?? "") ? req.query.status as "open" : undefined));
  app.post<{ Params: { id: string }; Body: DecideProposal }>("/api/handbook-proposals/:id", { schema: { body: DecideProposal } }, async (req) => s.handbooks.decide(actor(req), req.params.id, req.body.accept, req.body.text));

  // ---- the board (R7) ----
  app.get("/api/tickets", async () => s.tickets.list());
  app.post<{ Body: CreateTicket }>("/api/tickets", { schema: { body: CreateTicket } }, async (req) => s.tickets.create(actor(req), req.body));
  app.get("/api/tickets/settings", async () => s.tickets.settings());
  app.put<{ Body: TicketSettings }>("/api/tickets/settings", { schema: { body: TicketSettings } }, async (req) => s.tickets.setSettings(actor(req), req.body));
  app.get<{ Params: { key: string } }>("/api/tickets/:key", async (req) => s.tickets.view(req.params.key));
  app.patch<{ Params: { key: string }; Body: UpdateTicket }>("/api/tickets/:key", { schema: { body: UpdateTicket } }, async (req) => s.tickets.update(actor(req), req.params.key, req.body));
  app.post<{ Params: { key: string }; Body: MoveTicket }>("/api/tickets/:key/move", { schema: { body: MoveTicket } }, async (req) => s.tickets.move(actor(req), req.params.key, req.body));
  app.delete<{ Params: { key: string } }>("/api/tickets/:key", async (req, reply) => {
    s.tickets.remove(actor(req), req.params.key);
    return reply.code(204).send();
  });
  app.get<{ Params: { key: string } }>("/api/tickets/:key/events", async (req) => s.tickets.events(req.params.key));
  app.post<{ Params: { key: string }; Body: PromoteTicket }>("/api/tickets/:key/promote", { schema: { body: PromoteTicket } }, async (req) => s.tickets.promote(actor(req), req.params.key, req.body.repo ?? null));
  // R10: look at the change, send it back with comments, merge, retry; keep, finish or drop a local result.
  app.get<{ Params: { key: string } }>("/api/tickets/:key/diff", async (req) => s.tickets.diff(req.params.key));
  app.post<{ Params: { key: string }; Body: SendBack }>("/api/tickets/:key/send-back", { schema: { body: SendBack } }, async (req) => s.tickets.sendBack(actor(req), req.params.key, req.body.comments));
  app.post<{ Params: { key: string } }>("/api/tickets/:key/merge", async (req) => s.tickets.merge(actor(req), req.params.key));
  app.post<{ Params: { key: string }; Body: RetryTicket }>("/api/tickets/:key/retry", { schema: { body: RetryTicket } }, async (req) => s.tickets.retry(actor(req), req.params.key, req.body));
  app.post<{ Params: { key: string }; Body: PromoteTicket }>("/api/tickets/:key/keep", { schema: { body: PromoteTicket } }, async (req) => s.tickets.keep(actor(req), req.params.key, req.body.repo ?? null));
  app.post<{ Params: { key: string } }>("/api/tickets/:key/finish", async (req) => s.tickets.finishTicket(actor(req), req.params.key));
  app.post<{ Params: { key: string } }>("/api/tickets/:key/drop", async (req) => s.tickets.drop(actor(req), req.params.key));
  // Pictures: the raw image as the body (the browser's type and the name are not trusted; the bytes are checked).
  app.post<{ Params: { key: string }; Querystring: { name?: string }; Body: Buffer }>("/api/tickets/:key/attachments", { bodyLimit: MAX_UPLOAD_BYTES + 1024 }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the picture itself as the body");
    return s.tickets.attach(actor(req), req.params.key, String(req.query.name ?? "picture"), req.body);
  });
  app.get<{ Params: { key: string; id: string } }>("/api/tickets/:key/attachments/:id", async (req, reply) => {
    const t = s.tickets.row(req.params.key);
    return reply.type("image/jpeg").header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=86400").send(s.tickets.picture(t.id, req.params.id));
  });
  app.delete<{ Params: { key: string; id: string } }>("/api/tickets/:key/attachments/:id", async (req) => s.tickets.detach(actor(req), req.params.key, req.params.id));
  app.get("/api/missions", async () => s.missions.list());
  app.post<{ Body: CreateMission }>("/api/missions", { schema: { body: CreateMission } }, async (req) => s.missions.create(actor(req), req.body, "dashboard"));
  app.get<{ Params: { id: string } }>("/api/missions/:id", async (req) => s.missions.view(req.params.id));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/missions/:id/messages", async (req) => s.missions.messages(req.params.id, Number(req.query.after ?? 0) || 0));
  app.post<{ Params: { id: string }; Body: MissionReply }>("/api/missions/:id/messages", { schema: { body: MissionReply } }, async (req) => s.missions.reply(actor(req), req.params.id, req.body.text, "dashboard"));
  app.post<{ Params: { id: string } }>("/api/missions/:id/approve", async (req) => s.missions.approve(actor(req), req.params.id));
  app.post<{ Params: { id: string }; Body: MissionReply }>("/api/missions/:id/changes", { schema: { body: MissionReply } }, async (req) => s.missions.requestChanges(actor(req), req.params.id, req.body.text));
  app.post<{ Params: { id: string } }>("/api/missions/:id/cancel", async (req) => s.missions.cancel(actor(req), req.params.id));
  app.put<{ Params: { id: string }; Body: MissionBudget }>("/api/missions/:id/budget", { schema: { body: MissionBudget } }, async (req) => s.missions.setBudget(actor(req), req.params.id, req.body.budgetUsd));

  // ---- Discord ------------------------------------------------------------------------------
  app.get("/api/discord", async () => s.discord.status());
  app.put<{ Body: SetDiscord }>("/api/discord", { schema: { body: SetDiscord } }, async (req) => s.discord.configure(actor(req), req.body));
  app.post("/api/discord/test", async () => {
    await s.discord.test();
    return { ok: true };
  });

  // ---- CLI workers (R4) ---------------------------------------------------------------------
  const WS_ID = { type: "object", properties: { ws: { type: "string", pattern: "^ws-[0-9]{1,2}$" } }, required: ["ws"] } as const;
  const RUNTIME = { type: "object", properties: { runtime: { type: "string", enum: ["claude_code", "codex"] } }, required: ["runtime"] } as const;
  app.get("/api/cli", async () => s.cli.status());
  app.put<{ Body: SetCli }>("/api/cli", { schema: { body: SetCli } }, async (req) => s.cli.configure(actor(req), req.body));
  app.post("/api/cli/refresh", async () => s.cli.refresh());
  app.post<{ Params: { runtime: "claude_code" | "codex" } }>("/api/cli/:runtime/test", { schema: { params: RUNTIME } }, async (req) => s.cli.test(req.params.runtime));
  app.post<{ Params: { ws: string } }>("/api/cli/codex/:ws/login", { schema: { params: WS_ID } }, async (req) => s.cli.startCodexLogin(actor(req), req.params.ws));
  app.post<{ Params: { ws: string } }>("/api/cli/codex/:ws/login/cancel", { schema: { params: WS_ID } }, async (req) => {
    s.cli.cancelCodexLogin(req.params.ws);
    return s.cli.status();
  });
  app.post<{ Params: { ws: string } }>("/api/cli/codex/:ws/logout", { schema: { params: WS_ID } }, async (req) => s.cli.codexLogout(actor(req), req.params.ws));

  // ---- live updates -------------------------------------------------------------------------
  app.get("/api/ws", { websocket: true }, (socket) => {
    const off = s.bus.subscribe((msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    });
    socket.on("close", off);
    socket.on("error", off);
  });

  // ---- the dashboard ------------------------------------------------------------------------
  if (o.webDist && existsSync(o.webDist)) {
    await app.register(fastifyStatic, { root: o.webDist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
