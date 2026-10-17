import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { WEBHOOK_PATH, type LinearService } from "./linear-service.ts";

/**
 * Linear signs the time it sends. Its retries (after 1 minute, 1 hour and 6 hours) must still get in, so the
 * window is wide; replays are stopped by deduplicating on what Linear signed, kept a week.
 */
export const WEBHOOK_MAX_AGE_MS = 7 * 3_600_000;
const CLOCK_SKEW_MS = 60_000;

export interface WebhookDeps {
  readonly db: Db;
  readonly linear: LinearService;
  /** Called after an event is stored; handling happens after Linear has its answer. */
  readonly received: () => void;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

export function signatureOk(secret: string, raw: Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/**
 * The only thing reachable from the internet (through Tailscale Funnel): one route on its own port.
 * Each delivery is checked (signature, age, workspace), stored once (by what Linear signed), and answered at once:
 * Linear allows 5 seconds. Nothing in the body is logged.
 */
export function buildLinearWebhook(d: WebhookDeps, now: () => number = Date.now): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false, requestTimeout: 10_000, connectionTimeout: 10_000 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = req.body as Buffer;
    if (!/^[0-9a-f]{64}$/i.test(String(req.headers["linear-signature"] ?? ""))) return reply.status(401).send({ error: "Bad signature" });
    const secret = await d.linear.webhookSecret();
    if (!secret) return reply.status(503).send({ error: "Not configured" });
    if (!Buffer.isBuffer(raw) || !signatureOk(secret, raw, req.headers["linear-signature"] as string | undefined)) return reply.status(401).send({ error: "Bad signature" });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ error: "Bad body" });
    }
    const sent = Number(payload.webhookTimestamp);
    if (!Number.isFinite(sent) || sent > now() + CLOCK_SKEW_MS || now() - sent > WEBHOOK_MAX_AGE_MS) return reply.status(401).send({ error: "Stale" });
    // Only agent sessions matter, and only from the workspace agentSwarm is installed in.
    if (payload.type !== "AgentSessionEvent") return reply.status(200).send({ ok: true });
    const org = d.linear.stored().organizationId;
    if (org && payload.organizationId !== undefined && payload.organizationId !== org) return reply.status(200).send({ ok: true });
    // Deduplicated on what Linear signed (the Linear-Delivery header is not signed): the activity, else the body.
    const activity = (payload.agentActivity as { id?: unknown } | undefined)?.id;
    const delivery = typeof activity === "string" && activity
      ? `activity:${activity}`.slice(0, 120)
      : `body:${createHash("sha256").update(raw).digest("hex")}`;
    d.db.insert(schema.linearEvents).values({
      deliveryId: delivery, event: String(req.headers["linear-event"] ?? payload.type ?? "unknown").slice(0, 60), payload, receivedAt: now(), processedAt: null, error: null,
    }).onConflictDoNothing().run();
    setImmediate(d.received);
    return reply.status(200).send({ ok: true });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "Not found" }));
  return app;
}
