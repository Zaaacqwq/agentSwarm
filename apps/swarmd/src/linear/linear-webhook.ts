import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { WEBHOOK_PATH, type LinearService } from "./linear-service.ts";

/** Linear sends the time it signed; anything older (or from the future) than this is refused as a replay. */
export const WEBHOOK_TOLERANCE_MS = 60_000;

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
 * Each delivery is checked (signature, age), stored once (by delivery id), and answered at once:
 * Linear allows 5 seconds. Nothing in the body is logged.
 */
export function buildLinearWebhook(d: WebhookDeps, now: () => number = Date.now): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = req.body as Buffer;
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
    if (!Number.isFinite(sent) || Math.abs(now() - sent) > WEBHOOK_TOLERANCE_MS) return reply.status(401).send({ error: "Stale" });
    const delivery = String(req.headers["linear-delivery"] ?? `${String(payload.webhookId ?? "")}:${sent}`).slice(0, 100);
    d.db.insert(schema.linearEvents).values({
      deliveryId: delivery, event: String(req.headers["linear-event"] ?? payload.type ?? "unknown").slice(0, 60), payload, receivedAt: now(), processedAt: null, error: null,
    }).onConflictDoNothing().run();
    setImmediate(d.received);
    return reply.status(200).send({ ok: true });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "Not found" }));
  return app;
}
