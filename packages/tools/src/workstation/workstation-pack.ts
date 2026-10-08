import { Type } from "typebox";
import { defineHiveTool, type AnyHiveTool, type Toolpack, type ToolResult } from "../toolpack.ts";
import type { CommandResult, WorkstationPort } from "./workstation-port.ts";

export const WORKSTATION_PACK_ID = "core.workstation";
const MAX_TEXT = 8000;

const GUIDANCE = [
  "Workstation: you work in a git worktree on your own macOS workstation.",
  "Start with ws_checkout(repo, slug) to open a worktree on branch hive/<you>/<slug>; ws_where shows the current one.",
  "Paths are relative to the worktree root. Read before you edit; prefer ws_edit for small changes.",
  "Run tests with ws_bash. When done: git_commit, git_push, then pr_create. Never merge; humans merge.",
].join("\n");

async function attempt(work: () => Promise<string>): Promise<ToolResult> {
  try {
    return { text: clip(await work()) };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export function createWorkstationPack(port: WorkstationPort, health: () => Promise<{ available: boolean; reason?: string }>): Toolpack {
  const tools: AnyHiveTool[] = [
    defineHiveTool({
      name: "ws_where", label: "Where am I", access: "r",
      description: "Show your workstation, the active worktree (repo, branch) and the repositories you can check out.",
      parameters: Type.Object({}),
      execute: (ctx) => attempt(async () => {
        const w = await port.whereAmI(ctx);
        const wt = w.worktree ? `Active worktree: ${w.worktree.repo} on ${w.worktree.branch}` : "No active worktree; use ws_checkout.";
        return `Workstation: ${w.workstation}\n${wt}\nRepositories: ${w.repos.join(", ") || "(none registered)"}`;
      }),
    }),
    defineHiveTool({
      name: "ws_checkout", label: "Check out worktree", access: "w",
      description: "Open (or resume) your worktree for a repository on branch hive/<you>/<slug> and make it active.",
      parameters: Type.Object({
        repo: Type.String({ description: "Repository name, e.g. hive-sandbox" }),
        slug: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,59}$", description: "Short branch slug, e.g. fix-sum" }),
      }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.checkout(ctx, p.repo, p.slug);
        return `${r.created ? "Created" : "Resumed"} worktree for ${r.worktree.repo} on ${r.worktree.branch}${r.resumed && r.created ? " (branch existed upstream)" : ""}.`;
      }),
    }),
    defineHiveTool({
      name: "ws_list", label: "List files", access: "r",
      description: "List files under a directory of the active worktree.",
      parameters: Type.Object({ path: Type.Optional(Type.String()), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.list(ctx, p.path ?? ".", p.depth ?? 2);
        return r.entries.join("\n") + (r.truncated ? "\n(truncated; list a subdirectory)" : "");
      }),
    }),
    defineHiveTool({
      name: "ws_read", label: "Read file", access: "r",
      description: "Read a text file with line numbers. Page with offset/limit for long files.",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.read(ctx, p.path, p.offset ?? 1, p.limit ?? 300);
        const numbered = r.content.split("\n").map((line, i) => `${String(r.fromLine + i).padStart(5)}| ${line}`).join("\n");
        const end = r.fromLine + r.content.split("\n").length - 1;
        return `${p.path} (lines ${r.fromLine}-${end} of ${r.totalLines})\n${numbered}${r.truncated ? `\n(more: offset=${end + 1})` : ""}`;
      }),
    }),
    defineHiveTool({
      name: "ws_grep", label: "Search", access: "r",
      description: "Search the worktree with an extended regular expression.",
      parameters: Type.Object({ pattern: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()) }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.grep(ctx, p.pattern, p.path, p.glob);
        return r.matches.length ? r.matches.join("\n") + (r.truncated ? "\n(truncated)" : "") : "No matches.";
      }),
    }),
    defineHiveTool({
      name: "ws_write", label: "Write file", access: "claim",
      description: "Create or overwrite a file in the active worktree.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: (ctx, p) => attempt(async () => `Wrote ${(await port.write(ctx, p.path, p.content)).bytes} bytes to ${p.path}.`),
    }),
    defineHiveTool({
      name: "ws_edit", label: "Edit file", access: "claim",
      description: "Replace exact text in a file. old_text must match once unless replace_all is true.",
      parameters: Type.Object({ path: Type.String(), old_text: Type.String({ minLength: 1 }), new_text: Type.String(), replace_all: Type.Optional(Type.Boolean()) }),
      execute: (ctx, p) => attempt(async () => {
        const r = await port.edit(ctx, p.path, p.old_text, p.new_text, p.replace_all ?? false);
        return `Edited ${p.path} (${r.replacements} replacement${r.replacements === 1 ? "" : "s"}).`;
      }),
    }),
    defineHiveTool({
      name: "ws_bash", label: "Run command", access: "claim",
      description: "Run a shell command (zsh) in the worktree and wait for it. Network is available. Use terminals for long-running processes.",
      parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })) }),
      execute: (ctx, p, signal) => attempt(async () => formatCommand(await port.bash(ctx, p.command, (p.timeout_s ?? 120) * 1000, signal))),
    }),
    defineHiveTool({
      name: "term_create", label: "New terminal", access: "claim",
      description: "Start a persistent terminal (tmux) in the worktree for long-running processes.",
      parameters: Type.Object({ name: Type.String({ pattern: "^[A-Za-z0-9_-]{1,24}$" }) }),
      execute: (ctx, p) => attempt(async () => {
        await port.termCreate(ctx, p.name);
        return `Terminal ${p.name} started.`;
      }),
    }),
    defineHiveTool({
      name: "term_send", label: "Type in terminal", access: "claim",
      description: "Send keys to a terminal; by default presses Enter afterwards.",
      parameters: Type.Object({ name: Type.String(), keys: Type.String(), enter: Type.Optional(Type.Boolean()) }),
      execute: (ctx, p) => attempt(async () => {
        await port.termSend(ctx, p.name, p.keys, p.enter ?? true);
        return `Sent to ${p.name}.`;
      }),
    }),
    defineHiveTool({
      name: "term_read", label: "Read terminal", access: "r",
      description: "Read the last lines of a terminal's screen and scrollback.",
      parameters: Type.Object({ name: Type.String(), lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      execute: (ctx, p) => attempt(async () => (await port.termRead(ctx, p.name, p.lines ?? 60)) || "(empty)"),
    }),
    defineHiveTool({
      name: "term_kill", label: "Close terminal", access: "claim",
      description: "Stop a terminal and everything running in it.",
      parameters: Type.Object({ name: Type.String() }),
      execute: (ctx, p) => attempt(async () => {
        await port.termKill(ctx, p.name);
        return `Terminal ${p.name} closed.`;
      }),
    }),
    defineHiveTool({
      name: "git_status", label: "Git status", access: "r",
      description: "Show the worktree's git status and recent commits.",
      parameters: Type.Object({}),
      execute: (ctx) => attempt(async () => {
        const r = await port.gitStatus(ctx);
        return `${r.status}\n\nRecent:\n${r.recent}`;
      }),
    }),
    defineHiveTool({
      name: "git_commit", label: "Commit", access: "w",
      description: "Stage all changes in the worktree and commit them.",
      parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 5000 }) }),
      execute: (ctx, p) => attempt(async () => `Committed ${(await port.gitCommit(ctx, p.message)).head}.`),
    }),
    defineHiveTool({
      name: "git_push", label: "Push", access: "w",
      description: "Push your branch through the Git Relay (checks branch, history, size and secrets).",
      parameters: Type.Object({}),
      execute: (ctx) => attempt(() => port.gitPush(ctx)),
    }),
    defineHiveTool({
      name: "pr_create", label: "Open pull request", access: "w",
      description: "Open a pull request for your pushed branch against the default branch.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ maxLength: 20000 }) }),
      execute: (ctx, p) => attempt(async () => `Pull request: ${await port.pullRequest(ctx, p.title, p.body)}`),
    }),
  ];

  return {
    id: WORKSTATION_PACK_ID,
    label: "Workstation",
    tools: () => tools,
    leases: ["workstation-write", "heavy-task"],
    healthcheck: health,
    guidance: GUIDANCE,
  };
}

export function formatCommand(r: CommandResult): string {
  const status = r.timedOut ? "timed out" : r.exitCode === null ? "killed" : `exit ${r.exitCode}`;
  const header = `${status} · ${(r.durationMs / 1000).toFixed(1)}s${r.truncated ? " · output truncated (showing the end)" : ""}`;
  const body = r.output.length > MAX_TEXT - 200 ? `…${r.output.slice(-(MAX_TEXT - 200))}` : r.output;
  return `${header}\n${body || "(no output)"}`;
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n… [${text.length - MAX_TEXT} more chars; narrow the request]`;
}
