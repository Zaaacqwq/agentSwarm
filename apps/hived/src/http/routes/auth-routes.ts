import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Credentials, Ok, SessionInfo } from "@hive/core";
import { RateLimiter } from "../../auth/rate-limit.ts";
import { tooManyRequests } from "../errors.ts";
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie, type RouteDeps } from "../context.ts";

const LOGIN_ATTEMPTS_PER_MINUTE = 10;

export const authRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { auth } = deps.services;
  const limiter = new RateLimiter(LOGIN_ATTEMPTS_PER_MINUTE, 60_000);
  const throttle = (ip: string) => {
    if (!limiter.hit(ip)) throw tooManyRequests("Too many attempts; wait a minute and try again");
  };

  app.get("/session", { schema: { response: { 200: SessionInfo } } }, async (request) => ({
    setupRequired: auth.isSetupRequired(),
    user: request.authUser ? { id: request.authUser.id, username: request.authUser.username, role: request.authUser.role } : null,
  }));

  app.post("/setup", { schema: { body: Credentials, response: { 200: SessionInfo } } }, async (request, reply) => {
    throttle(request.ip);
    const session = await auth.setupAdmin(request.body);
    setSessionCookie(reply, session.token, session.expiresAt, deps.config.secureCookies);
    return { setupRequired: false, user: { id: session.user.id, username: session.user.username, role: session.user.role } };
  });

  app.post("/login", { schema: { body: Credentials, response: { 200: SessionInfo } } }, async (request, reply) => {
    throttle(request.ip);
    const session = await auth.login(request.body);
    setSessionCookie(reply, session.token, session.expiresAt, deps.config.secureCookies);
    return { setupRequired: false, user: { id: session.user.id, username: session.user.username, role: session.user.role } };
  });

  app.post("/logout", { schema: { response: { 200: Ok } } }, async (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, deps.config.secureCookies);
    return { ok: true as const };
  });
};
