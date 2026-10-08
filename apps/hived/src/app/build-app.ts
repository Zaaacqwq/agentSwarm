import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import fastifyStatic from "@fastify/static";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { existsSync } from "node:fs";
import type { Services } from "./services.ts";
import type { HiveConfig } from "../config.ts";
import { HttpError } from "../http/errors.ts";
import { SESSION_COOKIE, type RouteDeps } from "../http/context.ts";
import { authRoutes } from "../http/routes/auth-routes.ts";
import { endpointRoutes } from "../http/routes/endpoint-routes.ts";
import { agentRoutes } from "../http/routes/agent-routes.ts";
import { chatRoutes } from "../http/routes/chat-routes.ts";
import { metaRoutes } from "../http/routes/meta-routes.ts";
import { registerWebSocket } from "../http/routes/ws-route.ts";

const PUBLIC_API = new Set(["/api/auth/session", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AppOptions {
  readonly services: Services;
  readonly config: Pick<HiveConfig, "secureCookies" | "webDistDir">;
  readonly logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024, forceCloseConnections: true }).withTypeProvider<TypeBoxTypeProvider>();
  const deps: RouteDeps = { services: opts.services, config: opts.config };

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(swagger, {
    openapi: { info: { title: "Hive API", version: "0.1.0" } },
  });

  app.decorateRequest("authUser", null);
  app.addHook("onRequest", async (request) => {
    request.authUser = opts.services.auth.resolve(request.cookies[SESSION_COOKIE]);
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (MUTATING.has(request.method)) assertSameOrigin(request.headers.origin, request.headers.host);
    if (!PUBLIC_API.has(path) && !request.authUser) throw new HttpError(401, "unauthorized", "Login required");
  });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    if ((error as FastifyError).validation) return reply.status(400).send({ error: "validation", message: error.message });
    const status = (error as FastifyError).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.status(status).send({ error: status >= 500 ? "internal" : "request", message: status >= 500 ? "Internal error" : error.message });
  });

  await app.register(authRoutes(deps), { prefix: "/api/auth" });
  await app.register(endpointRoutes(deps), { prefix: "/api/endpoints" });
  await app.register(agentRoutes(deps), { prefix: "/api/agents" });
  await app.register(chatRoutes(deps), { prefix: "/api/channels" });
  await app.register(metaRoutes(deps), { prefix: "/api" });
  registerWebSocket(app, deps);
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  const dist = opts.config.webDistDir;
  if (dist && existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found", message: "No such route" });
      return reply.type("text/html").sendFile("index.html");
    });
  }
  return app;
}

/** Cookies are SameSite=Strict; this rejects cross-site writes from browsers that still send them. */
function assertSameOrigin(origin: string | undefined, host: string | undefined): void {
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "forbidden", "Bad origin");
  }
  if (originHost !== host) throw new HttpError(403, "forbidden", "Cross-origin request rejected");
}
