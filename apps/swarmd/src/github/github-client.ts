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
