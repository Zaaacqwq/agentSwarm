/** Runs git as the hived user (never inside a workstation). Credentials for GitHub come from gh. */
export interface GitResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export type GitRunner = (args: readonly string[], opts?: { cwd?: string; timeoutMs?: number; stdin?: string }) => Promise<GitResult>;

/** Workstation inboxes are owned by ws-N users; hived must be allowed to fetch from them. */
const SAFE_INBOXES = "/Volumes/HiveWS/inbox/*";

const GH_HELPER = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export const runGit: GitRunner = async (args, opts = {}) => {
  const usesGithub = args.some((a) => a.startsWith("https://github.com/"));
  const proc = Bun.spawn(["/usr/bin/git", ...(usesGithub ? GH_HELPER : []), ...args], {
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 300_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: SAFE_INBOXES },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};

export async function gitOk(git: GitRunner, args: readonly string[], opts?: Parameters<GitRunner>[1]): Promise<string> {
  const res = await git(args, opts);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.err || res.out).trim().slice(-500)}`);
  return res.out;
}
