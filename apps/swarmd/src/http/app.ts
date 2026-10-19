import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {
  CreateAgent, CreateEndpoint, CreateProject, CreateRun, Credentials, RunMessage, SetGitHubToken, type Me,
} from "@agentswarm/contracts";
import type { Services } from "../app/services.ts";
import { RateLimiter } from "../auth/rate-limit.ts";
import { SESSION_TTL_MS } from "../auth/auth-service.ts";
import { HttpError, forbidden, unauthorized } from "../errors.ts";
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

export async function buildApp(o: AppOptions): Promise<FastifyInstance> {
  const s = o.services;
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: false });
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
    const origin = req.headers.origin;
    if (origin && origin.toLowerCase() !== `http://${host}`) throw forbidden("Cross-origin request refused");
    // CSRF: state changes must be JSON (forms cannot send JSON cross-site).
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["content-length"] !== "0" && req.headers["content-length"] !== undefined && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
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
  app.get("/api/projects", async () => s.projects.list());
  app.post<{ Body: CreateProject }>("/api/projects", { schema: { body: CreateProject } }, async (req) => s.projects.create(actor(req), req.body));
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => s.projects.view(req.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/refresh", async (req) => s.projects.refresh(req.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/protect", async (req) => ({ protected: await s.projects.ensureProtected(req.params.id) }));
  app.get<{ Params: { id: string } }>("/api/projects/:id/pushes", async (req) => s.relay.history(req.params.id));

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
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (req) => s.runs.events(req.params.id, Number(req.query.after ?? 0) || 0));
  app.post<{ Params: { id: string }; Body: RunMessage }>("/api/runs/:id/messages", { schema: { body: RunMessage } }, async (req) => s.runs.message(actor(req), req.params.id, req.body.text));
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => s.runs.cancel(actor(req), req.params.id));

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
