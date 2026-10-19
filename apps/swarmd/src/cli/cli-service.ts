import { eq } from "drizzle-orm";
import type { CliQuotaView, CliRuntimeName, CliStatusView, CliTestResult, CodexLoginView, SetCli } from "@agentswarm/contracts";
import type { CliRunResult, CliStatus } from "@agentswarm/ws-exec";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { WorkstationPool } from "../workstations/pool.ts";
import { audit } from "../audit.ts";
import { badRequest } from "../errors.ts";
import { parserFor, type CliQuota } from "./cli-events.ts";

const ROW = "cli";
/** The versions swarmd's event parsing was tested with (scripts/setup.sh installs exactly these). */
export const PINNED: Record<CliRuntimeName, string> = { claude_code: "2.1.302", codex: "0.163.0" };
const DEFAULTS = { claudeEnabled: true, codexEnabled: true, maxConcurrent: 2, fiveHourLimit: 0.8, sevenDayLimit: 0.9 };
const TEST_SCOPE = "checks/cli-test";

interface Stored {
  readonly claudeEnabled: boolean;
  readonly codexEnabled: boolean;
  readonly maxConcurrent: number;
  readonly fiveHourLimit: number;
  readonly sevenDayLimit: number;
  readonly quota: CliQuota | null;
}

export interface CliServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly backend: WorkstationBackend;
  readonly pool: WorkstationPool;
  readonly bus: EventBus;
  readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  /** A workstation this service held (a sign-in, a test) is free again: queued runs may start. */
  readonly onFreed?: () => void;
}

/** Why a runtime cannot take a new sub-agent: "quota" passes on its own; "off" needs the person. */
export type Unavailable = { ok: false; reason: string; blocked: "quota" | "off" };

/** Codex prints where to confirm its device code; only OpenAI's own sign-in pages are shown as links. */
export const CODEX_SIGN_IN_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);

/** Settings, the Claude token, subscription quota and Codex sign-ins for the CLI workers (R4). */
export class CliService {
  private readonly deps: CliServiceDeps;
  private versions: { claude: string | null; codex: string | null } = { claude: null, codex: null };
  private checkedAt: number | null = null;
  private readonly logins = new Map<string, CodexLoginView>();
  private readonly loginAborts = new Map<string, AbortController>();
  /** One test per runtime and one refresh at a time: each holds workstations and spends quota. */
  private readonly testing = new Map<CliRuntimeName, Promise<CliTestResult>>();
  private refreshing: Promise<CliStatusView> | null = null;

  constructor(deps: CliServiceDeps) {
    this.deps = deps;
  }

  // ---- settings -------------------------------------------------------------------------

  private stored(): Stored {
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    return { ...DEFAULTS, quota: null, ...(row?.value as Partial<Stored> | undefined) };
  }

  private hasToken(): boolean {
    return Boolean(this.deps.db.select({ s: schema.settings.secretSealed }).from(schema.settings).where(eq(schema.settings.id, ROW)).get()?.s);
  }

  private save(value: Stored, secretSealed: string | null | undefined, now = Date.now()): void {
    const old = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    const values = { value: { ...value } as Record<string, unknown>, secretSealed: secretSealed === undefined ? old?.secretSealed ?? null : secretSealed, updatedAt: now };
    this.deps.db.insert(schema.settings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
  }

  async configure(actor: string, input: SetCli, now = Date.now()): Promise<CliStatusView> {
    const s = this.stored();
    const next: Stored = {
      ...s,
      ...(input.claudeEnabled !== undefined ? { claudeEnabled: input.claudeEnabled } : {}),
      ...(input.codexEnabled !== undefined ? { codexEnabled: input.codexEnabled } : {}),
      ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
      ...(input.fiveHourLimit !== undefined ? { fiveHourLimit: input.fiveHourLimit } : {}),
      ...(input.sevenDayLimit !== undefined ? { sevenDayLimit: input.sevenDayLimit } : {}),
    };
    if (input.claudeToken && input.clearClaudeToken) throw badRequest("Either set the token or clear it");
    const sealed = input.claudeToken ? await this.deps.secrets.seal(input.claudeToken) : input.clearClaudeToken ? null : undefined;
    this.save(next, sealed, now);
    const { claudeToken: _t, ...rest } = input;
    audit(this.deps.db, actor, "cli.configure", ROW, { ...rest, tokenChanged: Boolean(input.claudeToken) }, now);
    return this.publish();
  }

  /** The Claude Code token, opened only to hand it to ws-exec. */
  async claudeToken(): Promise<string | null> {
    const row = this.deps.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    return row?.secretSealed ? this.deps.secrets.open(row.secretSealed) : null;
  }

  maxConcurrent(): number {
    return this.stored().maxConcurrent;
  }

  // ---- quota ----------------------------------------------------------------------------

  recordQuota(quota: CliQuota): void {
    const s = this.stored();
    if (s.quota && s.quota.at > quota.at) return;
    this.save({ ...s, quota }, undefined);
    this.publish();
  }

  quota(): CliQuotaView | null {
    return this.stored().quota;
  }

  // ---- availability ---------------------------------------------------------------------

  /** Whether a sub-agent can be spawned with this runtime now; the reason is said to the lead. */
  availability(runtime: CliRuntimeName, now = Date.now()): { ok: true } | Unavailable {
    const s = this.stored();
    const off = (reason: string): Unavailable => ({ ok: false, reason, blocked: "off" });
    if (runtime === "claude_code") {
      if (!s.claudeEnabled) return off("Claude Code is switched off in the dashboard settings");
      if (!this.hasToken()) return off("Claude Code has no token yet (dashboard settings)");
      const q = s.quota;
      if (q) {
        const five = q.fiveHourResetsAt !== null && q.fiveHourResetsAt <= now ? 0 : q.fiveHour;
        const seven = q.sevenDayResetsAt !== null && q.sevenDayResetsAt <= now ? 0 : q.sevenDay;
        if (five >= s.fiveHourLimit) return { ok: false, blocked: "quota", reason: `Claude's 5-hour window is ${pct(five)} used (limit ${pct(s.fiveHourLimit)}); it resets ${when(q.fiveHourResetsAt)}` };
        if (seven >= s.sevenDayLimit) return { ok: false, blocked: "quota", reason: `Claude's 7-day window is ${pct(seven)} used (limit ${pct(s.sevenDayLimit)}); it resets ${when(q.sevenDayResetsAt)}` };
      }
      return { ok: true };
    }
    if (!s.codexEnabled) return off("Codex is switched off in the dashboard settings");
    if (this.deps.pool.codexReady().length === 0) return off("Codex is not signed in on any workstation (dashboard settings)");
    return { ok: true };
  }

  /** One line per runtime for the spawn_agent description. */
  runtimesNote(now = Date.now()): string {
    const q = this.stored().quota;
    const parts = (["claude_code", "codex"] as const).map((r) => {
      const a = this.availability(r, now);
      if (!a.ok) return `${r}: unavailable (${a.reason})`;
      if (r === "claude_code" && q) return `${r}: available (Claude subscription: 5-hour window ${pct(q.fiveHour)} used, 7-day ${pct(q.sevenDay)})`;
      return `${r}: available`;
    });
    return ["native: always available (your own model through agentSwarm)", ...parts].join("; ");
  }

  // ---- status ---------------------------------------------------------------------------

  status(now = Date.now()): CliStatusView {
    const s = this.stored();
    const claude = this.availability("claude_code", now);
    const codex = this.availability("codex", now);
    return {
      claude: { enabled: s.claudeEnabled, version: this.versions.claude, pinned: PINNED.claude_code, available: claude.ok, reason: claude.ok ? null : claude.reason, hasToken: this.hasToken(), quota: s.quota },
      codex: {
        enabled: s.codexEnabled, version: this.versions.codex, pinned: PINNED.codex, available: codex.ok, reason: codex.ok ? null : codex.reason,
        workstations: this.deps.pool.rows().map((w) => ({ workstationId: w.id, signedInAt: w.codexLoginAt, login: this.logins.get(w.id) ?? null })),
      },
      maxConcurrent: s.maxConcurrent, fiveHourLimit: s.fiveHourLimit, sevenDayLimit: s.sevenDayLimit, checkedAt: this.checkedAt,
    };
  }

  private publish(): CliStatusView {
    const cli = this.status();
    this.deps.bus.publish({ kind: "cli", cli });
    return cli;
  }

  /** Reads the installed versions, and which workstations are signed in to Codex. Never throws. */
  refresh(): Promise<CliStatusView> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(now = Date.now()): Promise<CliStatusView> {
    const rows = this.deps.pool.rows().filter((w) => w.status !== "unhealthy");
    const results = await Promise.all(rows.map(async (w) => {
      try {
        return { id: w.id, st: await this.deps.backend.call<CliStatus>(w.id, { op: "cli.status" }, { timeoutMs: 90_000 }) };
      } catch (error) {
        this.deps.log("cli status failed", { ws: w.id, error: (error as Error).message });
        return { id: w.id, st: null };
      }
    }));
    for (const { id, st } of results) {
      if (!st) continue;
      this.versions = { claude: st.claude ?? this.versions.claude, codex: st.codex ?? this.versions.codex };
      const row = rows.find((w) => w.id === id)!;
      if (st.codexSignedIn === true && row.codexLoginAt === null) this.deps.pool.setCodexLogin(id, now);
      // Only a clear "not signed in" clears it; a check that timed out says nothing.
      if (st.codexSignedIn === false && row.codexLoginAt !== null) this.deps.pool.setCodexLogin(id, null);
    }
    this.checkedAt = now;
    for (const [r, v] of [["claude_code", this.versions.claude], ["codex", this.versions.codex]] as const) {
      if (v && v !== PINNED[r]) this.deps.log("cli version differs from the tested one", { runtime: r, installed: v, tested: PINNED[r] });
    }
    return this.publish();
  }

  // ---- Codex sign-in --------------------------------------------------------------------

  /** Starts Codex's device-code sign-in on a free workstation; the URL and code appear in the status. */
  startCodexLogin(actor: string, workstationId: string, now = Date.now()): CliStatusView {
    if (this.logins.get(workstationId)?.state === "waiting") return this.status();
    const lease = `login:${workstationId}`;
    audit(this.deps.db, actor, "cli.codex_login", workstationId, {}, now);
    if (!this.deps.pool.acquire(lease, workstationId)) throw badRequest(`${workstationId} is busy or unhealthy; try again when it is free`);
    const abort = new AbortController();
    this.loginAborts.set(workstationId, abort);
    this.logins.set(workstationId, { state: "waiting", url: null, code: null, error: null });
    const lines: string[] = [];
    void this.deps.backend.call<{ exitCode: number | null; timedOut: boolean }>(workstationId, { op: "cli.login", runtime: "codex" }, {
      signal: abort.signal, timeoutMs: 16 * 60_000,
      onEvent: (e) => {
        const text = String((e as { text?: unknown }).text ?? "");
        if (!text) return;
        lines.push(text);
        const found = deviceCode(lines);
        const cur = this.logins.get(workstationId);
        if (cur?.state === "waiting" && (found.url !== cur.url || found.code !== cur.code)) {
          this.logins.set(workstationId, { ...cur, ...found });
          this.publish();
        }
      },
    }).then((res) => {
      const ok = res.exitCode === 0;
      this.logins.set(workstationId, { ...(this.logins.get(workstationId) ?? { url: null, code: null }), state: ok ? "done" : "failed", error: ok ? null : res.timedOut ? "The code expired before it was confirmed" : lastLine(lines) });
      if (ok) this.deps.pool.setCodexLogin(workstationId, Date.now());
    }).catch((error: Error) => {
      this.logins.set(workstationId, { ...(this.logins.get(workstationId) ?? { url: null, code: null }), state: "failed", error: error.message.slice(0, 300) });
    }).finally(async () => {
      this.loginAborts.delete(workstationId);
      await this.deps.pool.reap(workstationId).catch(() => undefined);
      this.deps.pool.release(workstationId, lease);
      this.deps.onFreed?.();
      this.publish();
    });
    return this.publish();
  }

  cancelCodexLogin(workstationId: string): void {
    this.loginAborts.get(workstationId)?.abort();
  }

  /** Signs Codex out of a free workstation (not from under a run that is using it). */
  async codexLogout(actor: string, workstationId: string, now = Date.now()): Promise<CliStatusView> {
    const lease = `logout:${workstationId}`;
    if (!this.deps.pool.acquire(lease, workstationId)) throw badRequest(`${workstationId} is busy or unhealthy; try again when it is free`);
    try {
      const res = await this.deps.backend.call<{ signedOut: boolean }>(workstationId, { op: "cli.logout", runtime: "codex" }, { timeoutMs: 90_000 });
      if (!res.signedOut) throw badRequest(`Codex did not sign out on ${workstationId}; try again`);
      this.deps.pool.setCodexLogin(workstationId, null);
      this.logins.delete(workstationId);
      audit(this.deps.db, actor, "cli.codex_logout", workstationId, {}, now);
    } finally {
      this.deps.pool.release(workstationId, lease);
      this.deps.onFreed?.();
    }
    return this.publish();
  }

  // ---- test -----------------------------------------------------------------------------

  /** Runs a one-line prompt on a free workstation, the same way a sub-agent would. */
  test(runtime: CliRuntimeName): Promise<CliTestResult> {
    const running = this.testing.get(runtime);
    if (running) return running;
    const p = this.doTest(runtime).finally(() => this.testing.delete(runtime));
    this.testing.set(runtime, p);
    return p;
  }

  private async doTest(runtime: CliRuntimeName): Promise<CliTestResult> {
    const credential = runtime === "claude_code" ? await this.claudeToken() : undefined;
    if (runtime === "claude_code" && !credential) return { ok: false, detail: "No Claude Code token yet", workstationId: null };
    const ready = new Set(this.deps.pool.codexReady());
    const lease = `test:${runtime}:${Date.now()}`;
    const ws = this.deps.pool.acquire(lease, null, Date.now(), runtime === "codex" ? (w) => ready.has(w.id) : () => true);
    if (!ws) return { ok: false, detail: runtime === "codex" && ready.size === 0 ? "Codex is not signed in on any workstation" : "No free workstation; try again in a moment", workstationId: null };
    const parser = parserFor(runtime, Date.now);
    let text = "";
    let error: string | null = null;
    try {
      await this.deps.backend.call(ws, { op: "exec", scope: TEST_SCOPE, command: "true" }, { timeoutMs: 30_000 });
      const res = await this.deps.backend.call<CliRunResult>(ws, {
        op: "cli.run", scope: TEST_SCOPE, runtime, prompt: "This is a connection test. Reply with exactly: OK", maxTurns: 2, timeoutMs: 180_000,
        ...(credential ? { credential } : {}),
      }, {
        timeoutMs: 240_000,
        onEvent: (e) => {
          for (const ev of parser.parse(e)) {
            if (ev.kind === "quota") this.recordQuota(ev.quota);
            if (ev.kind === "text") text = ev.text;
            if (ev.kind === "result") {
              text = ev.report?.summary ?? (ev.text || text);
              if (ev.isError) error = ev.error;
            }
            if (ev.kind === "error") error = ev.message;
          }
        },
      });
      if (res.exitCode !== 0 && !error) error = `${runtime} exited ${res.exitCode ?? "on a signal"}: ${res.stderr.trim().split("\n").pop() ?? ""}`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      await this.deps.pool.reap(ws).catch(() => undefined);
      this.deps.pool.release(ws, lease);
      this.deps.onFreed?.();
    }
    await this.refresh().catch(() => undefined);
    return error ? { ok: false, detail: error.slice(0, 500), workstationId: ws } : { ok: true, detail: `Replied: ${text.trim().slice(0, 200) || "(nothing)"}`, workstationId: ws };
  }
}

/** Finds the sign-in URL and the one-time code in what Codex printed. */
export function deviceCode(lines: readonly string[]): { url: string | null; code: string | null } {
  const text = lines.join("\n");
  const url = [...text.matchAll(/https:\/\/[^\s"'<>]+/g)].map((m) => m[0]).find((u) => {
    try {
      return CODEX_SIGN_IN_HOSTS.has(new URL(u).host);
    } catch {
      return false;
    }
  }) ?? null;
  const code = text.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0] ?? null;
  return { url, code };
}

function lastLine(lines: readonly string[]): string {
  return (lines.at(-1) ?? "Codex sign-in failed").slice(0, 300);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function when(ms: number | null): string {
  if (ms === null) return "later";
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60_000));
  return mins < 120 ? `in ${mins} min` : `in ${Math.round(mins / 60)} h`;
}
