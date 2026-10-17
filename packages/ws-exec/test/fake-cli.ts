import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

export interface FakeCliCall {
  readonly runtime: "claude" | "codex";
  readonly args: string[];
  readonly prompt: string;
  readonly resume: string | null;
  readonly cwd: string;
  readonly codexHome: string | null;
  readonly path: string;
  readonly tokenLength: number;
  readonly tokenInEnv: boolean;
  readonly home: string;
}

/** One run of the fake CLI (see fake-cli.mjs). */
export interface FakeStep {
  readonly write?: readonly { path: string; content: string }[];
  readonly commit?: string;
  readonly text?: string;
  readonly report?: { summary: string; tests: string; unfinished: string[] } | null;
  readonly error?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
  readonly tools?: number;
  readonly quota?: { five: number; seven: number };
  readonly usd?: number;
  readonly failResume?: boolean;
  readonly probe?: string;
  readonly longLived?: boolean;
  /** Codex: rotate the refresh token to this value, or swap the account id. */
  readonly rotate?: string;
  readonly swapAccount?: string;
  /** Write this file in the Codex home the run was given. */
  readonly plant?: string;
  /** Exit at once, before any event. */
  readonly crash?: boolean;
}

export interface FakeCli {
  readonly dir: string;
  script(steps: readonly FakeStep[]): void;
  calls(): FakeCliCall[];
  approveLogin(): void;
  sleeperPid(): number | null;
}

/** Installs fake `claude` and `codex` where ws-exec looks for them (<cliDir>/claude/claude, <cliDir>/codex/bin/codex). */
export function installFakeCli(cliDir: string): FakeCli {
  for (const d of [join(cliDir, "claude"), join(cliDir, "codex", "bin"), join(cliDir, "codex", "codex-path")]) mkdirSync(d, { recursive: true });
  // Copied next to the wrappers: the sandbox cannot read the repository (it lives under /Volumes).
  copyFileSync(SOURCE, join(cliDir, "fake-cli.mjs"));
  const wrapper = (name: string) => `#!/bin/sh\nexec "${process.execPath}" "${join(cliDir, "fake-cli.mjs")}" ${name} "$@"\n`;
  for (const [file, name] of [[join(cliDir, "claude", "claude"), "claude"], [join(cliDir, "codex", "bin", "codex"), "codex"]] as const) {
    writeFileSync(file, wrapper(name));
    chmodSync(file, 0o755);
  }
  const reset = () => {
    for (const f of ["state.json", "calls.jsonl", "approve-login", "deny-login", "sleeper.pid"]) rmSync(join(cliDir, f), { force: true });
  };
  reset();
  return {
    dir: cliDir,
    script: (steps) => {
      writeFileSync(join(cliDir, "script.json"), JSON.stringify(steps));
      rmSync(join(cliDir, "state.json"), { force: true });
    },
    calls: () => (existsSync(join(cliDir, "calls.jsonl")) ? readFileSync(join(cliDir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCliCall) : []),
    approveLogin: () => writeFileSync(join(cliDir, "approve-login"), ""),
    sleeperPid: () => (existsSync(join(cliDir, "sleeper.pid")) ? Number(readFileSync(join(cliDir, "sleeper.pid"), "utf8")) : null),
  };
}
