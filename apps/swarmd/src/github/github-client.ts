/** The only place swarmd talks to the GitHub API. Merging is never offered. */
export interface RepoInfo {
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly canAdmin: boolean;
  readonly cloneUrl: string;
}

export interface TokenInfo {
  readonly login: string;
  /** From the github-authentication-token-expiration header; null for tokens without expiry. */
  readonly expiresAt: number | null;
}

export interface GitHubClient {
  whoami(token: string): Promise<TokenInfo>;
  repo(token: string, fullName: string): Promise<RepoInfo>;
  isProtected(token: string, fullName: string, branch: string): Promise<boolean>;
  /** main: pull requests only (no approval required, so you can merge agentSwarm's PRs), admins included, no force pushes or deletion. */
  protect(token: string, fullName: string, branch: string): Promise<void>;
  /** Opens (or finds the open) pull request from `head` into `base`; returns its URL. Never merges. */
  createPullRequest(token: string, fullName: string, input: { head: string; base: string; title: string; body: string }): Promise<string>;
  pullRequestState(token: string, fullName: string, number: number): Promise<PullRequestState>;
  /** Deletes a swarm/… branch; false if it was already gone. */
  deleteBranch(token: string, fullName: string, branch: string): Promise<boolean>;
  /** The account's repositories, most recently updated first (for picking projects; access is checked on adding). */
  listRepos(token: string): Promise<{ fullName: string; private: boolean; description: string; updatedAt: string }[]>;
  /** A new, empty, private repository under the token's user (R5: an idea becomes a project). */
  createRepo(token: string, name: string, description: string): Promise<{ fullName: string }>;
  /** R10: only ever on your click on the dashboard (with a confirmation): agents never merge. */
  mergePullRequest(token: string, fullName: string, number: number): Promise<void>;
  /** R10: a retried ticket's earlier pull request. */
  closePullRequest(token: string, fullName: string, number: number): Promise<void>;
}

export type PullRequestState = "open" | "merged" | "closed";

/** The repository and number of a github.com pull request URL. */
export function parsePullRequestUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/([0-9]+)$/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHubRest implements GitHubClient {
  private readonly base: string;

  constructor(base = "https://api.github.com") {
    this.base = base;
  }

  async whoami(token: string): Promise<TokenInfo> {
    const res = await this.call(token, "GET", "/user");
    const body = (await res.json()) as { login: string };
    const expiry = res.headers.get("github-authentication-token-expiration");
    return { login: body.login, expiresAt: expiry ? Date.parse(expiry.replace(" UTC", "Z").replace(" ", "T")) || null : null };
  }

  async repo(token: string, fullName: string): Promise<RepoInfo> {
    const body = (await (await this.call(token, "GET", `/repos/${fullName}`)).json()) as {
      full_name: string; default_branch: string; private: boolean; clone_url: string; permissions?: { admin?: boolean };
    };
    return { fullName: body.full_name, defaultBranch: body.default_branch, private: body.private, canAdmin: body.permissions?.admin ?? false, cloneUrl: body.clone_url };
  }

  async isProtected(token: string, fullName: string, branch: string): Promise<boolean> {
    try {
      const body = (await (await this.call(token, "GET", `/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`)).json()) as {
        required_pull_request_reviews?: unknown; enforce_admins?: { enabled?: boolean }; allow_force_pushes?: { enabled?: boolean };
      };
      return Boolean(body.required_pull_request_reviews) && body.enforce_admins?.enabled === true && body.allow_force_pushes?.enabled !== true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  async protect(token: string, fullName: string, branch: string): Promise<void> {
    await this.call(token, "PUT", `/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`, {
      required_status_checks: null,
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  }

  async createPullRequest(token: string, fullName: string, input: { head: string; base: string; title: string; body: string }): Promise<string> {
    try {
      const created = (await (await this.call(token, "POST", `/repos/${fullName}/pulls`, input)).json()) as { html_url: string };
      return created.html_url;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      const owner = fullName.split("/")[0];
      const open = (await (await this.call(token, "GET", `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`)).json()) as { html_url: string }[];
      if (open[0]) return open[0].html_url;
      throw error;
    }
  }

  async listRepos(token: string) {
    const rows = (await (await this.call(token, "GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member")).json()) as { full_name: string; private: boolean; description: string | null; updated_at: string }[];
    return rows.map((r) => ({ fullName: r.full_name, private: r.private, description: r.description ?? "", updatedAt: r.updated_at }));
  }

  async createRepo(token: string, name: string, description: string): Promise<{ fullName: string }> {
    const created = (await (await this.call(token, "POST", "/user/repos", { name, description: description.slice(0, 300), private: true, auto_init: false })).json()) as { full_name: string };
    return { fullName: created.full_name };
  }

  async pullRequestState(token: string, fullName: string, number: number): Promise<PullRequestState> {
    const body = (await (await this.call(token, "GET", `/repos/${fullName}/pulls/${number}`)).json()) as { state: string; merged?: boolean; merged_at?: string | null };
    if (body.merged || body.merged_at) return "merged";
    return body.state === "open" ? "open" : "closed";
  }

  async mergePullRequest(token: string, fullName: string, number: number): Promise<void> {
    await this.call(token, "PUT", `/repos/${fullName}/pulls/${number}/merge`, {});
  }

  async closePullRequest(token: string, fullName: string, number: number): Promise<void> {
    await this.call(token, "PATCH", `/repos/${fullName}/pulls/${number}`, { state: "closed" });
  }

  async deleteBranch(token: string, fullName: string, branch: string): Promise<boolean> {
    if (!branch.startsWith("swarm/") || branch.split("/").some((p) => p === "" || p === "." || p === "..")) throw new Error(`Refusing to delete ${branch}: only swarm/ branches`);
    try {
      await this.call(token, "DELETE", `/repos/${fullName}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      return true;
    } catch (error) {
      // 422 "Reference does not exist" (GitHub may delete merged branches itself), or 404.
      if (error instanceof GitHubError && (error.status === 422 || error.status === 404)) return false;
      throw error;
    }
  }

  private async call(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          return text;
        }
      })();
      throw new GitHubError(res.status, `GitHub ${method} ${path.split("?")[0]} -> ${res.status}: ${message.slice(0, 200)}`);
    }
    return res;
  }
}
