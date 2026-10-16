import { eq } from "drizzle-orm";
import type { CreateEndpoint, EndpointView } from "@hive/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { newId } from "../crypto/tokens.ts";
import { audit } from "../audit.ts";
import { badRequest, notFound } from "../errors.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export interface EndpointSecret {
  readonly id: string;
  readonly kind: EndpointView["kind"];
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

type Row = typeof schema.endpoints.$inferSelect;

export class EndpointService {
  private readonly db: Db;
  private readonly secrets: SecretBox;

  constructor(db: Db, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  list(): EndpointView[] {
    return this.db.select().from(schema.endpoints).all().map(view);
  }

  async create(actor: string, input: CreateEndpoint, now = Date.now()): Promise<EndpointView> {
    const baseUrl = input.kind === "openrouter" ? OPENROUTER_URL : input.baseUrl?.replace(/\/+$/, "");
    if (!baseUrl) throw badRequest("An OpenAI-compatible endpoint needs a base URL");
    if (input.kind === "openrouter" && !input.apiKey) throw badRequest("OpenRouter needs an API key");
    const row: Row = {
      id: newId("ep"),
      name: input.name,
      kind: input.kind,
      baseUrl,
      apiKeySealed: input.apiKey ? await this.secrets.seal(input.apiKey) : null,
      createdAt: now,
    };
    this.db.insert(schema.endpoints).values(row).run();
    audit(this.db, actor, "endpoint.create", row.id, { kind: row.kind, name: row.name }, now);
    return view(row);
  }

  delete(actor: string, id: string): void {
    const used = this.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.endpointId, id)).limit(1).all();
    if (used.length > 0) throw badRequest("Agents still use this endpoint");
    const res = this.db.delete(schema.endpoints).where(eq(schema.endpoints.id, id)).run();
    if (res.changes === 0) throw notFound("No such endpoint");
    audit(this.db, actor, "endpoint.delete", id);
  }

  async secret(id: string): Promise<EndpointSecret> {
    const row = this.db.select().from(schema.endpoints).where(eq(schema.endpoints.id, id)).get();
    if (!row) throw notFound("No such endpoint");
    return { id: row.id, kind: row.kind, baseUrl: row.baseUrl, apiKey: row.apiKeySealed ? await this.secrets.open(row.apiKeySealed) : undefined };
  }
}

function view(row: Row): EndpointView {
  return { id: row.id, name: row.name, kind: row.kind, baseUrl: row.baseUrl, hasKey: row.apiKeySealed !== null, createdAt: row.createdAt };
}
