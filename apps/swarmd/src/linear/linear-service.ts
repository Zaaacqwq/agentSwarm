import { randomBytes } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import type { LinearOptionsView, LinearStatusView, SetLinear } from "@agentswarm/contracts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { audit } from "../audit.ts";
import { badRequest } from "../errors.ts";
import { AUTHORIZE_URL, type LinearApi } from "./linear-client.ts";

const ROW = "linear";
export const WEBHOOK_PATH = "/linear/webhook";
/** What the app asks for: read and write, and to be assignable and mentionable as an agent. */
const SCOPES = "read,write,app:assignable,app:mentionable";
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 5 * 60_000;

interface Stored {
  readonly clientId: string | null;
  readonly ownerUserId: string | null;
  readonly sandboxProjectId: string | null;
  readonly ideasProjectId: string | null;
  readonly maxActive: number;
  readonly organization: string | null;
  readonly appUserId: string | null;
  readonly appUser: string | null;
  readonly lastEventAt: number | null;
  readonly error: string | null;
}

interface Secrets {
  readonly clientSecret: string | null;
  readonly webhookSecret: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
}

const EMPTY: Stored = { clientId: null, ownerUserId: null, sandboxProjectId: null, ideasProjectId: null, maxActive: 3, organization: null, appUserId: null, appUser: null, lastEventAt: null, error: null };
const NO_SECRETS: Secrets = { clientSecret: null, webhookSecret: null, accessToken: null, refreshToken: null, expiresAt: null };

export interface LinearServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly api: LinearApi;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Linear settings: the application's credentials, the installation (OAuth, actor=app), and who is obeyed. */
export class LinearService {
  private readonly deps: LinearServiceDeps;
  private readonly states = new Map<string, number>();
  private refreshing: Promise<string> | null = null;
  /** Opened secrets, kept in memory: the webhook needs its signing secret within milliseconds. */
  private cache: Secrets | null = null;

  constructor(deps: LinearServiceDeps) {
    this.deps = deps;
  }

  get api(): LinearApi {
    return this.deps.api;
  }

  stored(): Stored {
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    return { ...EMPTY, ...(row?.value as Partial<Stored> | undefined) };
  }

  private async opened(): Promise<Secrets> {
    if (this.cache) return this.cache;
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    this.cache = row?.secretSealed ? { ...NO_SECRETS, ...(JSON.parse(await this.deps.secrets.open(row.secretSealed)) as Partial<Secrets>) } : NO_SECRETS;
    return this.cache;
  }

  private async save(value: Partial<Stored>, secrets?: Partial<Secrets>, now = Date.now()): Promise<void> {
    const next = { ...this.stored(), ...value };
    const merged = secrets ? { ...(await this.opened()), ...secrets } : null;
    const old = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    const sealed = merged ? await this.deps.secrets.seal(JSON.stringify(merged)) : old?.secretSealed ?? null;
    const values = { value: next as unknown as Record<string, unknown>, secretSealed: sealed, updatedAt: now };
    this.deps.db.insert(schema.settings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
    if (merged) this.cache = merged;
  }

  async configure(actor: string, input: SetLinear): Promise<LinearStatusView> {
    const { clientSecret, webhookSecret, ...rest } = input;
    const secrets = {
      ...(clientSecret ? { clientSecret } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    };
    await this.save(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), Object.keys(secrets).length ? secrets : undefined);
    audit(this.deps.db, actor, "linear.configure", ROW, { ...rest, clientSecretChanged: Boolean(clientSecret), webhookSecretChanged: Boolean(webhookSecret) });
    return this.status();
  }

  async status(): Promise<LinearStatusView> {
    const s = this.stored();
    const sec = await this.opened();
    const queue = this.deps.db.select().from(schema.linearSessions).where(inArray(schema.linearSessions.status, ["queued", "active"]))
      .orderBy(desc(schema.linearSessions.updatedAt)).limit(50).all()
      .map((r) => ({ key: r.issueKey, title: r.title, status: r.status, url: r.issueUrl, missionId: r.missionId }));
    return {
      configured: Boolean(s.clientId && sec.clientSecret), connected: Boolean(sec.accessToken), organization: s.organization, appUser: s.appUser,
      clientId: s.clientId, hasWebhookSecret: Boolean(sec.webhookSecret), ownerUserId: s.ownerUserId, sandboxProjectId: s.sandboxProjectId,
      ideasProjectId: s.ideasProjectId, maxActive: s.maxActive, webhookPath: WEBHOOK_PATH, lastEventAt: s.lastEventAt, error: s.error, queue,
    };
  }

  // ---- installation (OAuth, actor=app) ---------------------------------------------------

  /** The Linear page that installs agentSwarm as an agent in your workspace. */
  connectUrl(redirectUri: string, now = Date.now()): string {
    const s = this.stored();
    if (!s.clientId) throw badRequest("Add the Linear application's client ID and secret first");
    for (const [k, t] of this.states) if (t < now) this.states.delete(k);
    const state = randomBytes(16).toString("hex");
    this.states.set(state, now + STATE_TTL_MS);
    const q = new URLSearchParams({ client_id: s.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, state, actor: "app", prompt: "consent" });
    return `${AUTHORIZE_URL}?${q}`;
  }

  async callback(actor: string, code: string, state: string, redirectUri: string, now = Date.now()): Promise<void> {
    const expires = this.states.get(state);
    this.states.delete(state);
    if (!expires || expires < now) throw badRequest("This sign-in link expired; start again from the settings");
    const s = this.stored();
    const sec = await this.opened();
    if (!s.clientId || !sec.clientSecret) throw badRequest("Add the Linear application's client ID and secret first");
    const t = await this.deps.api.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: s.clientId, client_secret: sec.clientSecret });
    const me = await this.deps.api.viewer(t.accessToken);
    await this.save({ organization: me.organization, appUserId: me.id, appUser: me.name, error: null }, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    audit(this.deps.db, actor, "linear.connect", ROW, { organization: me.organization });
  }

  async disconnect(actor: string): Promise<LinearStatusView> {
    await this.save({ organization: null, appUserId: null, appUser: null }, { accessToken: null, refreshToken: null, expiresAt: null });
    audit(this.deps.db, actor, "linear.disconnect", ROW);
    return this.status();
  }

  /** A valid access token, refreshed ahead of expiry (refresh tokens rotate: one refresh at a time). */
  async accessToken(now = Date.now()): Promise<string> {
    const sec = await this.opened();
    if (!sec.accessToken) throw new Error("Linear is not connected");
    if (!sec.expiresAt || sec.expiresAt - REFRESH_EARLY_MS > now || !sec.refreshToken) return sec.accessToken;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const s = this.stored();
    const sec = await this.opened();
    try {
      const t = await this.deps.api.token({ grant_type: "refresh_token", refresh_token: sec.refreshToken!, client_id: s.clientId ?? "", client_secret: sec.clientSecret ?? "" });
      await this.save({ error: null }, { accessToken: t.accessToken, refreshToken: t.refreshToken ?? sec.refreshToken, expiresAt: t.expiresAt });
      return t.accessToken;
    } catch (error) {
      await this.save({ error: `Could not refresh the Linear sign-in: ${(error as Error).message}` });
      throw error;
    }
  }

  async webhookSecret(): Promise<string | null> {
    return (await this.opened()).webhookSecret;
  }

  async noteEvent(now = Date.now()): Promise<void> {
    await this.save({ lastEventAt: now });
  }

  async noteError(message: string | null): Promise<void> {
    if (this.stored().error !== message) await this.save({ error: message });
  }

  /** People and projects in the workspace, for the settings page. */
  async options(): Promise<LinearOptionsView> {
    const token = await this.accessToken();
    const [users, projects] = await Promise.all([this.deps.api.users(token), this.deps.api.projects(token)]);
    return { users, projects: projects.map((p) => ({ id: p.id, name: p.name })) };
  }
}
