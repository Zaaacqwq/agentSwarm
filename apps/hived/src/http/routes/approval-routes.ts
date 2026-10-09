import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { Approval, ApprovalQuery, BrowserProfile, DecideApproval, DesktopStatus, IdParams, Ok, Screenshot } from "@hive/core";
import type { AuthUser } from "../../auth/auth-service.ts";
import { requireUser, type RouteDeps } from "../context.ts";
import { badRequest, forbidden } from "../errors.ts";

const IMAGE_HEADERS = {
  "Content-Type": "image/jpeg",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

function requireAdmin(user: AuthUser): AuthUser {
  if (user.role !== "admin") throw forbidden("Only admins can do this");
  return user;
}

/** Approvals, the desktop session and agent screenshots (P5). */
export const approvalRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { approvals, desktop, screenshots, browser, agents, bus } = deps.services;

  app.get("/approvals", { schema: { querystring: ApprovalQuery, response: { 200: Type.Array(Approval) } } }, async (req) =>
    approvals.list(requireUser(req), req.query),
  );

  app.post("/approvals/:id/decide", { schema: { params: IdParams, body: DecideApproval, response: { 200: Approval } } }, async (req) =>
    approvals.decide(requireUser(req), req.params.id, req.body),
  );

  app.post("/approvals/:id/revoke", { schema: { params: IdParams, response: { 200: Approval } } }, async (req) =>
    approvals.revoke(requireUser(req), req.params.id),
  );

  app.get("/desktop", { schema: { response: { 200: DesktopStatus } } }, async (req) => {
    requireUser(req);
    return desktop.status();
  });

  // The live view of the user's own screen: admins only, never cached.
  app.get("/desktop/screen", { schema: { querystring: Type.Object({ display: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })) }) } }, async (req, reply) => {
    requireAdmin(requireUser(req));
    try {
      const shot = await desktop.preview(req.query.display ?? 0);
      return reply.headers({ ...IMAGE_HEADERS, "Cache-Control": "no-store" }).send(shot.jpeg);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/desktop/stop", { schema: { response: { 200: Ok } } }, async (req) => {
    const user = requireAdmin(requireUser(req));
    const status = await desktop.status();
    if (status.holder) approvals.revoke(user, status.holder.approvalId);
    await desktop.end();
    return { ok: true as const };
  });

  app.get("/agents/:id/screenshots", { schema: { params: IdParams, response: { 200: Type.Array(Screenshot) } } }, async (req) => {
    const user = requireUser(req);
    agents.getRow(user.orgId, req.params.id);
    return screenshots.listForAgent(user.orgId, req.params.id).filter((s) => s.source === "browser" || user.role === "admin");
  });

  app.get("/screenshots/:id", { schema: { params: IdParams } }, async (req, reply) => {
    const user = requireUser(req);
    const { row, data } = screenshots.bytes(user.orgId, req.params.id);
    // Desktop screenshots show the owner's own screen.
    if (row.source === "desktop") requireAdmin(user);
    return reply.headers({ ...IMAGE_HEADERS, "Cache-Control": "private, max-age=86400" }).send(data);
  });

  app.get("/agents/:id/browser", { schema: { params: IdParams, response: { 200: BrowserProfile } } }, async (req) => {
    const user = requireUser(req);
    agents.getRow(user.orgId, req.params.id);
    const profile = browser.profile(req.params.id);
    return {
      exists: profile !== null,
      workstationId: profile?.workstationId ?? null,
      lastUsedAt: profile?.lastUsedAt ?? null,
      siteApprovals: approvals.list(user, { agentId: req.params.id, status: "active" }).filter((a) => a.kind === "browser_site"),
    };
  });

  app.post("/agents/:id/browser/reset", { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    const user = requireAdmin(requireUser(req));
    agents.getRow(user.orgId, req.params.id);
    try {
      await browser.reset(req.params.id);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
    bus.publish(user.orgId, { type: "agent.updated", agent: agents.get(user, req.params.id) });
    return { ok: true as const };
  });
};
