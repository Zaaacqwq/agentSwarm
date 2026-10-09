export interface PullRequestInput {
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/** The only place hived talks to GitHub's API. Merging is never offered. */
export interface PullRequestStatus {
  readonly state: "open" | "merged" | "closed";
  readonly checksFailed: boolean;
}

export interface PullRequestView {
  readonly title: string;
  readonly state: string;
  readonly files: { path: string; additions: number; deletions: number }[];
  readonly diff: string;
  readonly checks: string;
}

export interface GitHubPort {
  createPullRequest(input: PullRequestInput): Promise<string>;
  status?(url: string): Promise<PullRequestStatus>;
  view?(url: string): Promise<PullRequestView>;
  comment?(url: string, body: string): Promise<void>;
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

  async status(url) {
    const res = await gh(["pr", "view", url, "--json", "state,mergedAt,statusCheckRollup"]);
    if (res.code !== 0) throw new Error(`gh pr view failed: ${res.err.slice(0, 200)}`);
    const data = JSON.parse(res.out) as { state: string; mergedAt: string | null; statusCheckRollup?: { conclusion?: string; state?: string }[] };
    const state = data.mergedAt || data.state === "MERGED" ? "merged" : data.state === "CLOSED" ? "closed" : "open";
    const checksFailed = (data.statusCheckRollup ?? []).some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes((c.conclusion ?? c.state ?? "").toUpperCase()));
    return { state, checksFailed };
  },

  async view(url) {
    const meta = await gh(["pr", "view", url, "--json", "title,state,files,statusCheckRollup"]);
    if (meta.code !== 0) throw new Error(`gh pr view failed: ${meta.err.slice(0, 200)}`);
    const data = JSON.parse(meta.out) as { title: string; state: string; files: { path: string; additions: number; deletions: number }[]; statusCheckRollup?: { name?: string; conclusion?: string; state?: string }[] };
    const diff = await gh(["pr", "diff", url]);
    const checks = (data.statusCheckRollup ?? []).map((c) => `${c.name ?? "check"}: ${c.conclusion ?? c.state ?? "pending"}`).join(", ") || "no checks";
    return { title: data.title, state: data.state, files: data.files, diff: diff.code === 0 ? diff.out : "", checks };
  },

  async comment(url, body) {
    const res = await gh(["pr", "comment", url, "--body-file", "-"], body);
    if (res.code !== 0) throw new Error(`gh pr comment failed: ${res.err.slice(0, 200)}`);
  },
};
