import { eq } from "drizzle-orm";
import type { BackupModel, ModelSettings } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { ModelGateway } from "./model-gateway.ts";

const ROW = "models";

/** Errors that mean the provider refused the content (moderation), not that it is down: retrying the same model is pointless. */
export const REFUSAL = /data[_ ]inspection|inappropriate content|content[ _-]?(filter|policy|management|moderation)|flagged by (the )?moderation|moderation (failed|blocked|rejected)|safety (system|policy|filter)/i;

/**
 * The model a native run switches to when its own refuses the content or keeps failing (R8 follow-up):
 * the provider's moderation once stopped a ticket's lead for good.
 */
export class BackupModelService {
  private readonly db: Db;
  private readonly gateway: ModelGateway;

  constructor(db: Db, gateway: ModelGateway) {
    this.db = db;
    this.gateway = gateway;
  }

  get(): ModelSettings {
    const v = this.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get()?.value as Partial<ModelSettings> | undefined;
    return { backup: v?.backup ?? null };
  }

  backup(): BackupModel | null {
    return this.get().backup;
  }

  /** Checked against the endpoint's model list before it is kept: a typo would only show when it is needed. */
  async set(actor: string, input: ModelSettings, now = Date.now()): Promise<ModelSettings> {
    const backup = input.backup ? { endpointId: input.backup.endpointId, modelId: input.backup.modelId.trim() } : null;
    if (backup) await this.gateway.resolve(backup.endpointId, backup.modelId);
    const values = { value: { backup } as Record<string, unknown>, secretSealed: null, updatedAt: now };
    this.db.insert(schema.settings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
    audit(this.db, actor, "models.backup", ROW, { backup }, now);
    return this.get();
  }
}
