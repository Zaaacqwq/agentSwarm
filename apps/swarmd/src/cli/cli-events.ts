import type { RunReport } from "@agentswarm/contracts";
import type { CliRuntime } from "@agentswarm/ws-exec";

/** What swarmd takes from either CLI's event stream; anything else is skipped. */
export type CliEvent =
  | { readonly kind: "session"; readonly id: string; readonly model: string | null }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_start"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "tool_end"; readonly id: string; readonly name: string; readonly isError: boolean; readonly output: string }
  /** A model turn began (live turn count; the final count comes with usage). */
  | { readonly kind: "turn" }
  | { readonly kind: "usage"; readonly tokensIn: number; readonly tokensOut: number; readonly estimatedUsd: number | null; readonly turns: number | null }
  | { readonly kind: "quota"; readonly quota: CliQuota }
  | { readonly kind: "result"; readonly report: RunReport | null; readonly text: string; readonly isError: boolean; readonly error: string | null; readonly verdict?: Verdict | null }
  | { readonly kind: "error"; readonly message: string };

/** Claude's subscription windows: share used (0–1) and when each resets (ms). */
export interface CliQuota {
  readonly fiveHour: number;
  readonly fiveHourResetsAt: number | null;
  readonly sevenDay: number;
  readonly sevenDayResetsAt: number | null;
  readonly status: string;
  readonly at: number;
}

export interface Verdict {
  readonly approved: boolean;
  readonly comments: string;
}

/** `{approved, comments}` from a CLI reviewer's structured output (an object or its JSON text), or null. */
export function toVerdict(value: unknown): Verdict | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v.trim());
    } catch {
      return null;
    }
  }
  const o = obj(v);
  if (typeof o.approved !== "boolean" || typeof o.comments !== "string" || !o.comments.trim()) return null;
  return { approved: o.approved, comments: o.comments.trim().slice(0, 8000) };
}

export interface CliParser {
  parse(event: unknown): CliEvent[];
}

export function parserFor(runtime: CliRuntime, now: () => number = Date.now): CliParser {
  return runtime === "codex" ? new CodexParser() : new ClaudeParser(now);
}

type Obj = Record<string, unknown>;
/** What ws-exec accepts back as a session to resume (it starts with a letter or digit). */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
const session = (id: string, model: string | null): CliEvent[] => (SESSION.test(id) ? [{ kind: "session", id, model }] : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const OUTPUT_MAX = 4000;

/** `{summary, tests, unfinished}` from structured output (an object or its JSON text), or null. */
export function toReport(value: unknown): RunReport | null {
  let v = value;
  if (typeof v === "string") {
    const text = v.trim();
    if (!text.startsWith("{")) return null;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const o = obj(v);
  if (typeof o.summary !== "string" || !o.summary.trim()) return null;
  const unfinished = Array.isArray(o.unfinished) ? o.unfinished.filter((u): u is string => typeof u === "string" && u.trim() !== "") : [];
  return { summary: o.summary.trim(), tests: str(o.tests).trim() || "(not reported)", unfinished };
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, OUTPUT_MAX);
  if (Array.isArray(content)) return content.map((c) => str(obj(c).text)).join("\n").slice(0, OUTPUT_MAX);
  return "";
}

/** Claude Code `-p --output-format stream-json --verbose`. */
export class ClaudeParser implements CliParser {
  private readonly tools = new Map<string, string>();
  private readonly messages = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  parse(event: unknown): CliEvent[] {
    const e = obj(event);
    switch (e.type) {
      case "system":
        if (e.subtype === "init") return session(str(e.session_id), str(e.model) || null);
        if (e.subtype === "api_retry") return [{ kind: "error", message: "Claude API request failed; Claude Code is retrying" }];
        return [];
      case "assistant": {
        const m = obj(e.message);
        const out: CliEvent[] = [];
        // One message arrives as several events (one per content block) with the same id.
        const id = str(m.id);
        if (id && !this.messages.has(id)) {
          this.messages.add(id);
          out.push({ kind: "turn" });
        }
        for (const c of Array.isArray(m.content) ? m.content.map(obj) : []) {
          if (c.type === "text" && str(c.text).trim()) out.push({ kind: "text", text: str(c.text) });
          if (c.type === "tool_use") {
            this.tools.set(str(c.id), str(c.name));
            // StructuredOutput is how the final report arrives; the result event carries it.
            if (c.name !== "StructuredOutput") out.push({ kind: "tool_start", id: str(c.id), name: str(c.name), args: c.input ?? {} });
          }
        }
        return out;
      }
      case "user": {
        const m = obj(e.message);
        const out: CliEvent[] = [];
        for (const c of Array.isArray(m.content) ? m.content.map(obj) : []) {
          if (c.type !== "tool_result") continue;
          const name = this.tools.get(str(c.tool_use_id)) ?? "tool";
          if (name === "StructuredOutput") continue;
          out.push({ kind: "tool_end", id: str(c.tool_use_id), name, isError: c.is_error === true, output: toolText(c.content) });
        }
        return out;
      }
      case "rate_limit_event": {
        const info = obj(e.rate_limit_info);
        const windows = obj(info.unifiedWindows);
        const five = obj(windows.five_hour);
        const seven = obj(windows.seven_day);
        // Both windows or nothing: a missing one must not read as 0% used.
        if (typeof five.utilization !== "number" || typeof seven.utilization !== "number") return [];
        const resets = (w: Obj) => (typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null);
        return [{ kind: "quota", quota: { fiveHour: num(five.utilization), fiveHourResetsAt: resets(five), sevenDay: num(seven.utilization), sevenDayResetsAt: resets(seven), status: str(info.status) || "allowed", at: this.now() } }];
      }
      case "result": {
        const u = obj(e.usage);
        const usage: CliEvent = {
          kind: "usage",
          tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
          tokensOut: num(u.output_tokens),
          estimatedUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
          turns: typeof e.num_turns === "number" ? e.num_turns : null,
        };
        const isError = e.is_error === true || e.subtype !== "success";
        const report = toReport(e.structured_output) ?? toReport(e.result);
        const error = isError ? claudeError(e) : null;
        return [usage, { kind: "result", report, text: str(e.result), isError, error, verdict: toVerdict(e.structured_output) ?? toVerdict(e.result) }];
      }
      default:
        return [];
    }
  }
}

function claudeError(e: Obj): string {
  if (e.subtype === "error_max_turns") return "Claude Code reached its turn limit";
  if (e.subtype === "error_max_structured_output_retries") return "Claude Code did not produce the final report";
  const text = str(e.result).trim();
  return (text || `Claude Code ended with ${str(e.subtype) || "an error"}`).slice(0, 500);
}

const CODEX_TOOL: Record<string, string> = { command_execution: "shell", file_change: "edit", mcp_tool_call: "mcp", web_search: "web_search" };

/** Codex `exec --json`. Item ids restart at every execution, so the caller keeps them apart. */
export class CodexParser implements CliParser {
  private readonly started = new Set<string>();
  private lastMessage = "";
  private turns = 0;

  parse(event: unknown): CliEvent[] {
    const e = obj(event);
    switch (e.type) {
      case "thread.started":
        return session(str(e.thread_id), null);
      case "turn.started":
        this.turns++;
        return [{ kind: "turn" }];
      case "item.started": {
        const item = obj(e.item);
        const name = CODEX_TOOL[str(item.type)];
        if (!name) return [];
        this.started.add(str(item.id));
        return [{ kind: "tool_start", id: str(item.id), name, args: codexArgs(item) }];
      }
      case "item.completed": {
        const item = obj(e.item);
        const type = str(item.type);
        if (type === "agent_message") {
          this.lastMessage = str(item.text);
          // The last message is the structured report or verdict; it is shown as the result, not as chat.
          return toReport(this.lastMessage) || toVerdict(this.lastMessage) ? [] : [{ kind: "text", text: this.lastMessage }];
        }
        if (type === "error") return [{ kind: "error", message: str(item.message).slice(0, 500) }];
        const name = CODEX_TOOL[type];
        if (!name) return [];
        const id = str(item.id);
        const out: CliEvent[] = this.started.has(id) ? [] : [{ kind: "tool_start", id, name, args: codexArgs(item) }];
        this.started.delete(id);
        const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        out.push({ kind: "tool_end", id, name, isError: failed, output: codexOutput(item) });
        return out;
      }
      case "turn.completed": {
        const u = obj(e.usage);
        return [
          { kind: "usage", tokensIn: num(u.input_tokens), tokensOut: num(u.output_tokens) + num(u.reasoning_output_tokens), estimatedUsd: null, turns: this.turns },
          { kind: "result", report: toReport(this.lastMessage), text: this.lastMessage, isError: false, error: null, verdict: toVerdict(this.lastMessage) },
        ];
      }
      case "turn.failed": {
        const message = str(obj(e.error).message) || "Codex failed";
        return [{ kind: "result", report: toReport(this.lastMessage), text: this.lastMessage, isError: true, error: message.slice(0, 500) }];
      }
      case "error":
        return [{ kind: "error", message: (str(e.message) || "Codex error").slice(0, 500) }];
      default:
        return [];
    }
  }
}

function codexArgs(item: Obj): unknown {
  if (item.type === "command_execution") return { command: str(item.command) };
  if (item.type === "file_change") return { changes: Array.isArray(item.changes) ? item.changes : [] };
  return {};
}

function codexOutput(item: Obj): string {
  if (item.type === "command_execution") {
    const code = typeof item.exit_code === "number" ? `exit ${item.exit_code}` : str(item.status);
    return `${str(item.aggregated_output)}${code ? `\n(${code})` : ""}`.slice(0, OUTPUT_MAX);
  }
  if (item.type === "file_change") {
    return (Array.isArray(item.changes) ? item.changes.map(obj) : []).map((c) => `${str(c.kind)} ${str(c.path)}`).join("\n").slice(0, OUTPUT_MAX);
  }
  return str(item.status);
}
