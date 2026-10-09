import type { AgentContext } from "../toolpack.ts";

export interface WorktreeView {
  readonly repo: string;
  readonly branch: string;
  readonly scope: string;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * What core.workstation needs from hived. hived resolves the agent's workstation and
 * active worktree, enforces leases and heavy-task slots, and talks to hive-exec.
 * Methods throw Error with a model-readable message on failure.
 */
export interface WorkstationPort {
  whereAmI(ctx: AgentContext): Promise<{ workstation: string; worktree: WorktreeView | null; repos: string[] }>;
  checkout(ctx: AgentContext, repo: string, slug: string): Promise<{ worktree: WorktreeView; created: boolean; resumed: boolean }>;
  list(ctx: AgentContext, path: string, depth: number): Promise<{ entries: string[]; truncated: boolean }>;
  read(ctx: AgentContext, path: string, offset: number, limit: number): Promise<{ content: string; fromLine: number; totalLines: number; truncated: boolean }>;
  grep(ctx: AgentContext, pattern: string, path: string | undefined, glob: string | undefined): Promise<{ matches: string[]; truncated: boolean }>;
  write(ctx: AgentContext, path: string, content: string): Promise<{ bytes: number }>;
  edit(ctx: AgentContext, path: string, oldText: string, newText: string, replaceAll: boolean): Promise<{ replacements: number }>;
  bash(ctx: AgentContext, command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>;
  termCreate(ctx: AgentContext, name: string): Promise<void>;
  termSend(ctx: AgentContext, name: string, keys: string, enter: boolean): Promise<void>;
  termRead(ctx: AgentContext, name: string, lines: number): Promise<string>;
  termKill(ctx: AgentContext, name: string): Promise<void>;
  gitStatus(ctx: AgentContext): Promise<{ status: string; recent: string }>;
  gitCommit(ctx: AgentContext, message: string): Promise<{ head: string }>;
  gitPush(ctx: AgentContext): Promise<string>;
  pullRequest(ctx: AgentContext, title: string, body: string): Promise<string>;
  attachFile(ctx: AgentContext, channelId: string, path: string, caption: string): Promise<string>;
}
