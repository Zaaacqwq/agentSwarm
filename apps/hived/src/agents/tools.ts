import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ExecResult, Request } from "@hive/ws-exec";
import type { RunReport } from "@hive/contracts";
import type { WorkstationBackend } from "../workstations/backend.ts";

export interface ToolContext {
  readonly backend: WorkstationBackend;
  readonly workstation: string;
  readonly scope: string;
  readonly push: (signal?: AbortSignal) => Promise<{ ok: boolean; message: string }>;
  readonly report: (report: RunReport) => void;
}

const text = (t: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text: t }], details: undefined });

function tool<P extends TSchema>(name: string, description: string, parameters: P, run: (params: any, signal?: AbortSignal) => Promise<string | AgentToolResult<undefined>>): AgentTool<P, undefined> {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      const out = await run(params, signal);
      return typeof out === "string" ? text(out) : out;
    },
  };
}

/** The R1 toolset: everything runs as the leased workstation user, inside its sandbox. */
export function workstationTools(ctx: ToolContext): AgentTool<any, undefined>[] {
  const call = <T>(request: Request, signal?: AbortSignal, timeoutMs?: number) =>
    ctx.backend.call<T>(ctx.workstation, request, { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const scope = ctx.scope;

  return [
    tool("ws_list", "List files and directories under a path (default: the worktree root).",
      Type.Object({ path: Type.Optional(Type.String()), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }),
      async (p, signal) => {
        const r = await call<{ entries: string[]; truncated: boolean }>({ op: "fs.list", scope, path: p.path ?? ".", ...(p.depth ? { depth: p.depth } : {}) }, signal);
        return `${r.entries.join("\n")}${r.truncated ? "\n… (truncated)" : ""}` || "(empty)";
      }),

    tool("ws_read", "Read a text file. Use offset (1-based line) and limit for long files.",
      Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
      async (p, signal) => {
        const r = await call<{ content: string; fromLine: number; totalLines: number; truncated: boolean }>({ op: "fs.read", scope, path: p.path, ...(p.offset ? { offset: p.offset } : {}), ...(p.limit ? { limit: p.limit } : {}) }, signal);
        const lines = r.content.split("\n").map((l, i) => `${String(r.fromLine + i).padStart(5)}  ${l}`).join("\n");
        return `${p.path} (lines ${r.fromLine}-${r.fromLine + r.content.split("\n").length - 1} of ${r.totalLines})\n${lines}${r.truncated ? "\n… more lines; read on with offset" : ""}`;
      }),

    tool("ws_grep", "Search files with an extended regular expression. Returns path:line:text.",
      Type.Object({ pattern: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()) }),
      async (p, signal) => {
        const r = await call<{ matches: string[]; truncated: boolean }>({ op: "fs.grep", scope, pattern: p.pattern, ...(p.path ? { path: p.path } : {}), ...(p.glob ? { glob: p.glob } : {}) }, signal);
        return r.matches.length ? `${r.matches.join("\n")}${r.truncated ? "\n… (truncated)" : ""}` : "No matches.";
      }),

    tool("ws_write", "Create or replace a whole file.",
      Type.Object({ path: Type.String(), content: Type.String() }),
      async (p, signal) => {
        const r = await call<{ bytes: number }>({ op: "fs.write", scope, path: p.path, content: p.content }, signal);
        return `Wrote ${p.path} (${r.bytes} bytes).`;
      }),

    tool("ws_edit", "Replace exact text in a file. old_text must match exactly once unless replace_all is true.",
      Type.Object({ path: Type.String(), old_text: Type.String({ minLength: 1 }), new_text: Type.String(), replace_all: Type.Optional(Type.Boolean()) }),
      async (p, signal) => {
        const r = await call<{ replacements: number }>({ op: "fs.edit", scope, path: p.path, oldText: p.old_text, newText: p.new_text, ...(p.replace_all ? { replaceAll: true } : {}) }, signal);
        return `Edited ${p.path} (${r.replacements} replacement${r.replacements === 1 ? "" : "s"}).`;
      }),

    tool("ws_bash", "Run a shell command (zsh) in the worktree, e.g. tests. Output is the tail if long. Default timeout 120 s, max 600 s.",
      Type.Object({ command: Type.String({ minLength: 1 }), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })) }),
      async (p, signal) => {
        const timeoutMs = (p.timeout_seconds ?? 120) * 1000;
        const r = await call<ExecResult>({ op: "exec", scope, command: p.command, timeoutMs }, signal, timeoutMs + 30_000);
        const status = r.timedOut ? `timed out after ${Math.round(r.durationMs / 1000)} s` : `exit code ${r.exitCode}`;
        return `${status}${r.truncated ? " (output truncated to the tail)" : ""}\n${r.output}`;
      }),

    tool("git_status", "Show the branch, changed files and recent commits.",
      Type.Object({}),
      async (_p, signal) => {
        const r = await call<{ status: string; recent: string }>({ op: "git.status", scope }, signal);
        return `${r.status}\n\nRecent commits:\n${r.recent}`;
      }),

    tool("git_commit", "Stage all changes and commit them.",
      Type.Object({ message: Type.String({ minLength: 1, maxLength: 5000 }) }),
      async (p, signal) => `Committed ${(await call<{ head: string }>({ op: "git.commit", scope, message: p.message }, signal)).head}.`),

    tool("git_push", "Push your branch through Hive's Relay to GitHub. Commit first.",
      Type.Object({}),
      async (_p, signal) => {
        const r = await ctx.push(signal);
        if (!r.ok) throw new Error(r.message);
        return r.message;
      }),

    reportTool(ctx.report),
  ];
}

const ReportParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  tests: Type.String({ maxLength: 4000 }),
  unfinished: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
});

function reportTool(onReport: (report: RunReport) => void): AgentTool<typeof ReportParams, undefined> {
  return {
    name: "report",
    label: "report",
    description: "Finish the task: what you did, the test results, and anything unfinished. Call this last.",
    parameters: ReportParams,
    execute: async (_id, p) => {
      onReport({ summary: p.summary, tests: p.tests, unfinished: p.unfinished });
      return { ...text("Report received. You are done."), terminate: true };
    },
  };
}
