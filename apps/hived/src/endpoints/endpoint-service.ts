import { and, eq } from "drizzle-orm";
import { newId, type CreateEndpoint, type Endpoint, type UpdateEndpoint } from "@hive/core";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import type { AuthUser } from "../auth/auth-service.ts";
import { writeAudit } from "../audit/audit.ts";
import { badRequest, conflict, notFound } from "../http/errors.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type EndpointRow = typeof schema.endpoints.$inferSelect;

export interface ResolvedEndpoint {
  readonly id: string;
  readonly kind: Endpoint["kind"];
  readonly baseUrl: string;
  readonly apiKey: string;
}

export class EndpointService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  list(user: AuthUser): Endpoint[] {
    return this.db.select().from(schema.endpoints).where(eq(schema.endpoints.orgId, user.orgId)).all().map(toEndpoint);
  }

  async create(user: AuthUser, input: CreateEndpoint, now = Date.now()): Promise<Endpoint> {
    const baseUrl = resolveBaseUrl(input.kind, input.baseUrl);
    this.assertNameFree(user.orgId, input.name);
    const row: EndpointRow = {
      id: newId("ep"),
      orgId: user.orgId,
      ownerUserId: user.id,
      name: input.name,
      kind: input.kind,
      baseUrl,
      apiKeyCiphertext: await this.secrets.seal(input.apiKey),
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.endpoints).values(row).run();
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "endpoint.create", targetId: row.id, metadata: { kind: row.kind } }, now);
    return toEndpoint(row);
  }

  async update(user: AuthUser, id: string, input: UpdateEndpoint, now = Date.now()): Promise<Endpoint> {
    const current = this.getRow(user, id);
    if (input.name && input.name !== current.name) this.assertNameFree(user.orgId, input.name);
    const next: EndpointRow = {
      ...current,
      name: input.name ?? current.name,
      baseUrl: input.baseUrl !== undefined ? resolveBaseUrl(current.kind, input.baseUrl) : current.baseUrl,
      apiKeyCiphertext: input.apiKey !== undefined ? await this.secrets.seal(input.apiKey) : current.apiKeyCiphertext,
      updatedAt: now,
    };
    this.db.update(schema.endpoints).set(next).where(eq(schema.endpoints.id, id)).run();
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateEndpoint] !== undefined);
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "endpoint.update", targetId: id, metadata: { fields } }, now);
    return toEndpoint(next);
  }

  remove(user: AuthUser, id: string, now = Date.now()): void {
    this.getRow(user, id);
    this.db.delete(schema.endpoints).where(eq(schema.endpoints.id, id)).run();
    writeAudit(this.db, { orgId: user.orgId, actorKind: "user", actorId: user.id, action: "endpoint.delete", targetId: id }, now);
  }

  exists(orgId: string, id: string): boolean {
    return !!this.db.select({ id: schema.endpoints.id }).from(schema.endpoints)
      .where(and(eq(schema.endpoints.id, id), eq(schema.endpoints.orgId, orgId))).get();
  }

  /** Decrypts the key for an outbound model call. Never return this through the API. */
  async resolveForRun(orgId: string, id: string): Promise<ResolvedEndpoint> {
    const row = this.db.select().from(schema.endpoints)
      .where(and(eq(schema.endpoints.id, id), eq(schema.endpoints.orgId, orgId))).get();
    if (!row) throw notFound("Endpoint");
    return { id: row.id, kind: row.kind, baseUrl: row.baseUrl, apiKey: await this.secrets.open(row.apiKeyCiphertext) };
  }

  private getRow(user: AuthUser, id: string): EndpointRow {
    const row = this.db.select().from(schema.endpoints)
      .where(and(eq(schema.endpoints.id, id), eq(schema.endpoints.orgId, user.orgId))).get();
    if (!row) throw notFound("Endpoint");
    return row;
  }

  private assertNameFree(orgId: string, name: string): void {
    const clash = this.db.select({ id: schema.endpoints.id }).from(schema.endpoints)
      .where(and(eq(schema.endpoints.orgId, orgId), eq(schema.endpoints.name, name))).get();
    if (clash) throw conflict(`An endpoint named "${name}" already exists`);
  }
}

function resolveBaseUrl(kind: Endpoint["kind"], baseUrl: string | undefined): string {
  if (kind === "openrouter") return (baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  if (!baseUrl) throw badRequest("An OpenAI-compatible endpoint needs a base URL");
  return baseUrl.replace(/\/+$/, "");
}

function toEndpoint(row: EndpointRow): Endpoint {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasApiKey: row.apiKeyCiphertext.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
