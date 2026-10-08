export interface PullRequestInput {
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/** The only place hived talks to GitHub's API. Merging is never offered. */
export interface GitHubPort {
  createPullRequest(input: PullRequestInput): Promise<string>;
}

async function gh(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

export const ghCli: GitHubPort = {
  async createPullRequest(input) {
    const created = await gh(["pr", "create", "--repo", input.repo, "--head", input.head, "--base", input.base, "--title", input.title, "--body-file", "-"], input.body);
    if (created.code === 0) return created.out.split("\n").pop() ?? created.out;
    if (/already exists/i.test(created.err)) {
      const existing = await gh(["pr", "view", input.head, "--repo", input.repo, "--json", "url", "--jq", ".url"]);
      if (existing.code === 0 && existing.out) return existing.out;
    }
    throw new Error(`gh pr create failed: ${created.err.slice(0, 300)}`);
  },
};
