import { randomBytes } from "node:crypto";
import type { CliRuntimeName, RunReport } from "@agentswarm/contracts";
import type { CliRunResult, ExecResult } from "@agentswarm/ws-exec";
import type { WorkstationBackend } from "../workstations/backend.ts";
import type { Relay } from "../relay/relay.ts";
import type { RunRow } from "../agents/run-service.ts";
import { cliFollowUp, cliPrompt, cliReviewPrompt } from "./cli-prompts.ts";
import { parserFor, type CliEvent, type Verdict } from "./cli-events.ts";
import type { CliService } from "./cli-service.ts";

const BASE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

export interface CliProgress {
  readonly turns: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedUsd: number;
}

/** One execution of a CLI run, as RunService sees it. */
export interface CliExecution {
  readonly run: RunRow;
  readonly runtime: CliRuntimeName;
  readonly name: string;
  readonly role: string;
  readonly repo: string;
  readonly defaultBranch: string;
  /** The project's profile as prompt lines (R5). */
  readonly project?: readonly string[];
  /** The model the agent asked for, if it named one for this CLI. */
  readonly model: string | null;
  readonly workstation: string;
  readonly signal: AbortSignal;
  /** The message that starts this execution (the brief first, then follow-ups). */
  readonly message: string;
  event(type: "assistant" | "tool_start" | "tool_end" | "error" | "status", data: Record<string, unknown>): void;
  progress(p: CliProgress): void;
  session(id: string): void;
}

export interface CliOutcome {
  readonly report: RunReport;
  /** Set when the run should end failed (the CLI failed, or stopped at a limit). */
  readonly error: string | null;
  /** A review run's verdict (null: it gave none). */
  readonly verdict?: Verdict | null;
}

export interface CliRunnerDeps {
  readonly backend: WorkstationBackend;
  readonly relay: Relay;
  readonly cli: CliService;
  readonly getRun: (id: string) => RunRow;
}

/** Runs Claude Code or Codex in a run's worktree, then commits what it left and pushes through the Relay. */
export class CliRunner {
  private readonly deps: CliRunnerDeps;

  constructor(deps: CliRunnerDeps) {
    this.deps = deps;
  }

  async execute(x: CliExecution): Promise<CliOutcome> {
    const credential = x.runtime === "claude_code" ? (await this.deps.cli.claudeToken()) ?? undefined : undefined;
    if (x.runtime === "claude_code" && !credential) throw new Error("Claude Code has no token (dashboard settings)");
    if (x.run.kind === "review") return this.review(x, credential);
    const resume = x.run.cliSession ?? undefined;
    const first = (message: string) => cliPrompt({ name: x.name, role: x.role, repo: x.repo, branch: x.run.branch, base: x.run.baseBranch ?? x.defaultBranch, message, ...(x.project ? { project: x.project } : {}) });
    // No session to continue: the CLI hears the task itself, not only the latest message ("Continue.",
    // an answer) — unless that message is the brief (the first execution).
    const prompt = resume ? cliFollowUp(x.message)
      : x.message.includes(x.run.brief.trim()) ? first(x.message)
      : first(`${x.run.brief}\n\nAn earlier attempt did not start a session; anything it did is in this worktree (see git log and git status).\n\nThe latest message:\n${x.message}`);
    let attempt = await this.once(x, prompt, resume, credential);
    // A session the CLI no longer has (its files are gone): start a new one with the whole story.
    if (resume && !attempt.sawSession && attempt.res.exitCode !== 0 && !x.signal.aborted) {
      x.event("error", { message: `${x.runtime} could not continue its earlier session; starting a new one` });
      const fresh = first(`${x.run.brief}\n\nYour earlier session is gone, but your work so far is in this worktree (see git log and git status).\n\nThe latest message:\n${x.message}`);
      attempt = await this.once(x, fresh, undefined, credential);
    }
    const { res, result, lastText } = attempt;
    const pushError = await this.commitAndPush(x);
    const report: RunReport = result?.report ?? { summary: (result?.text || lastText || `(${x.runtime} finished without a report)`).slice(0, 8000), tests: "(not reported)", unfinished: [] };
    let error: string | null = null;
    if (res.stoppedFor === "turns") error = "Stopped: the run reached its turn limit";
    else if (res.timedOut) error = "Stopped: the run reached its time limit";
    else if (result?.isError) error = result.error ?? `${x.runtime} reported an error`;
    else if (!result) error = `${x.runtime} ${res.exitCode === 0 ? "ended without its final result" : `exited ${res.exitCode ?? "on a signal"}`}: ${res.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || "(no output)"}`;
    if (pushError) error = error ? `${error}; ${pushError}` : pushError;
    return { report, error };
  }

  /** A reviewer: one pass, nothing pushed, the verdict from its structured answer. */
  private async review(x: CliExecution, credential: string | undefined): Promise<CliOutcome> {
    const prompt = cliReviewPrompt({ name: x.name, repo: x.repo, branch: x.run.branch, message: x.message, ...(x.project ? { project: x.project } : {}) });
    const { res, result } = await this.once(x, prompt, undefined, credential, "review");
    const verdict = result?.verdict ?? null;
    let error: string | null = null;
    if (res.stoppedFor === "turns") error = "Stopped: the run reached its turn limit";
    else if (res.timedOut) error = "Stopped: the run reached its time limit";
    else if (!verdict) error = `${x.runtime} gave no verdict${result?.error ? `: ${result.error}` : ""}`;
    const summary = verdict ? `${verdict.approved ? "Approved" : "Changes requested"}: ${verdict.comments}` : (result?.text || "(no verdict)").slice(0, 8000);
    return { report: { summary, tests: "", unfinished: [] }, error, verdict };
  }

  /** After a stop (time limit): keep what the CLI did, so the parent can see and continue it. Returns a problem, or null. */
  async salvage(x: Pick<CliExecution, "run" | "workstation" | "runtime" | "event" | "defaultBranch">): Promise<string | null> {
    return this.commitAndPush(x).catch((error: Error) => `Could not keep the CLI's work: ${error.message}`);
  }

  private async once(x: CliExecution, prompt: string, resume: string | undefined, credential: string | undefined, output: "report" | "review" = "report") {
    const parser = parserFor(x.runtime);
    // CLI tool ids restart in every execution (and this process restarts): keep them apart in the run's events.
    const n = randomBytes(3).toString("hex");
    // Fresh: a second attempt in the same execution adds to the first one's counts.
    const now = this.deps.getRun(x.run.id);
    const base = { turns: now.turns, tokensIn: now.tokensIn, tokensOut: now.tokensOut, estimatedUsd: now.estimatedUsd };
    const live = { ...base };
    let sawSession = false;
    let lastText = "";
    let result: Extract<CliEvent, { kind: "result" }> | null = null;
    const handle = (ev: CliEvent) => {
      switch (ev.kind) {
        case "session":
          sawSession = true;
          if (ev.id) x.session(ev.id);
          x.event("status", { status: "cli", runtime: x.runtime, session: ev.id, ...(ev.model ? { model: ev.model } : {}) });
          return;
        case "text":
          lastText = ev.text;
          x.event("assistant", { text: ev.text, tools: [] });
          return;
        case "tool_start":
          x.event("tool_start", { id: `${n}:${ev.id}`, name: ev.name, args: ev.args });
          return;
        case "tool_end":
          x.event("tool_end", { id: `${n}:${ev.id}`, name: ev.name, isError: ev.isError, output: ev.output, ms: null });
          return;
        case "turn":
          live.turns += 1;
          x.progress(live);
          return;
        case "usage":
          // Claude reports totals for the execution; Codex reports each turn.
          if (x.runtime === "claude_code") {
            Object.assign(live, { tokensIn: base.tokensIn + ev.tokensIn, tokensOut: base.tokensOut + ev.tokensOut, estimatedUsd: base.estimatedUsd + (ev.estimatedUsd ?? 0) });
            if (ev.turns !== null) live.turns = base.turns + ev.turns;
          } else {
            Object.assign(live, { tokensIn: live.tokensIn + ev.tokensIn, tokensOut: live.tokensOut + ev.tokensOut });
          }
          x.progress(live);
          return;
        case "quota":
          this.deps.cli.recordQuota(ev.quota);
          return;
        case "result":
          result = ev;
          return;
        case "error":
          x.event("error", { message: ev.message });
          return;
      }
    };
    const res = await this.deps.backend.call<CliRunResult>(x.workstation, {
      op: "cli.run", scope: x.run.worktreeScope, runtime: x.runtime, prompt, maxTurns: x.run.limits.maxTurns, output,
      // A backstop only: RunService stops the run at its own deadline.
      timeoutMs: x.run.limits.maxDurationMs + 60_000,
      ...(resume ? { resume } : {}), ...(x.model ? { model: x.model } : {}), ...(credential ? { credential } : {}),
    }, {
      signal: x.signal, timeoutMs: x.run.limits.maxDurationMs + 120_000,
      onEvent: (e) => {
        for (const ev of parser.parse(e)) handle(ev);
      },
    });
    return { res, result: result as Extract<CliEvent, { kind: "result" }> | null, lastText, sawSession };
  }

  /** Commits anything left uncommitted, then pushes new commits through the Relay. Returns a problem, or null. */
  private async commitAndPush(x: Pick<CliExecution, "run" | "workstation" | "runtime" | "event" | "defaultBranch">): Promise<string | null> {
    const { backend, relay } = this.deps;
    const run = this.deps.getRun(x.run.id);
    try {
      await backend.call(x.workstation, { op: "git.commit", scope: run.worktreeScope, message: `Uncommitted changes left by ${x.runtime === "codex" ? "Codex" : "Claude Code"}` }, { timeoutMs: 180_000 });
      x.event("status", { status: "committed", note: "agentSwarm committed changes the CLI left uncommitted" });
    } catch (error) {
      if (!/Nothing to commit/.test((error as Error).message)) return `Could not commit the CLI's changes: ${(error as Error).message}`;
    }
    const base = run.baseBranch ?? x.defaultBranch;
    if (!BASE_REF.test(base) || base.includes("..")) return "Invalid base branch";
    const out = await backend.call<ExecResult>(x.workstation, { op: "exec", scope: run.worktreeScope, command: `git rev-list --count 'origin/${base}..HEAD'` }, { timeoutMs: 60_000 });
    if (Number(out.output.trim()) === 0) return null;
    const pushed = await relay.push(run);
    return pushed.ok ? null : pushed.message;
  }
}
