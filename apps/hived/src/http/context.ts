import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/auth-service.ts";
import type { Services } from "../app/services.ts";
import type { HiveConfig } from "../config.ts";
import { unauthorized } from "./errors.ts";

export const SESSION_COOKIE = "hive_session";

export interface RouteDeps {
  readonly services: Services;
  readonly config: Pick<HiveConfig, "secureCookies">;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure, path: "/" });
}
