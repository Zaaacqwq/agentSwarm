/** What agentSwarm needs from Linear's API (GraphQL + OAuth). Tests use a fake; production talks to api.linear.app. */

export interface LinearIssue {
  readonly id: string;
  /** e.g. ZAC-42 */
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  readonly priority: number;
  readonly labels: readonly string[];
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly teamId: string;
}

export interface LinearState {
  readonly id: string;
  readonly name: string;
  /** backlog | unstarted | started | completed | canceled | triage */
  readonly type: string;
}

export type ActivityContent =
  | { readonly type: "thought" | "elicitation" | "response" | "error"; readonly body: string }
  | { readonly type: "action"; readonly action: string; readonly parameter: string; readonly result?: string };

export interface ActivityOptions {
  readonly ephemeral?: boolean;
  /** Elicitations with buttons. */
  readonly select?: readonly { label: string; value: string }[];
}

export interface PlanStep {
  readonly content: string;
  readonly status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** ms */
  readonly expiresAt: number;
}

export interface LinearApi {
  /** The app's own user in the workspace (installed with actor=app). */
  viewer(token: string): Promise<{ id: string; name: string; organization: string; organizationId: string }>;
  users(token: string): Promise<{ id: string; name: string; email: string }[]>;
  projects(token: string): Promise<{ id: string; name: string; teamIds: string[] }[]>;
  teams(token: string): Promise<{ id: string; key: string; name: string }[]>;
  issue(token: string, id: string): Promise<LinearIssue>;
  states(token: string, teamId: string): Promise<LinearState[]>;
  updateIssue(token: string, id: string, input: { stateId?: string; projectId?: string }): Promise<void>;
  createProject(token: string, name: string, teamIds: string[]): Promise<{ id: string }>;
  createActivity(token: string, sessionId: string, content: ActivityContent, opts?: ActivityOptions): Promise<void>;
  updateSession(token: string, sessionId: string, input: { plan?: readonly PlanStep[]; externalUrls?: readonly { label: string; url: string }[] }): Promise<void>;
  /** OAuth: the authorization-code exchange and refreshes (refresh tokens rotate). */
  token(params: Record<string, string>): Promise<LinearTokens>;
}

const API = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
export const AUTHORIZE_URL = "https://linear.app/oauth/authorize";

export class LinearError extends Error {}

/** Linear's GraphQL API over fetch; every request has a time limit. */
export class LinearGraphql implements LinearApi {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async gql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!res.ok || body?.errors?.length || !body?.data) {
      throw new LinearError(`Linear ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") ?? res.statusText}`.slice(0, 400));
    }
    return body.data;
  }

  async viewer(token: string) {
    const d = await this.gql<{ viewer: { id: string; name: string; organization: { id: string; name: string } } }>(token, "query { viewer { id name organization { id name } } }");
    return { id: d.viewer.id, name: d.viewer.name, organization: d.viewer.organization.name, organizationId: d.viewer.organization.id };
  }

  async users(token: string) {
    const d = await this.gql<{ users: { nodes: { id: string; name: string; email: string; active: boolean }[] } }>(token, "query { users(first: 100) { nodes { id name email active } } }");
    return d.users.nodes.filter((u) => u.active).map(({ id, name, email }) => ({ id, name, email }));
  }

  async projects(token: string) {
    const d = await this.gql<{ projects: { nodes: { id: string; name: string; teams: { nodes: { id: string }[] } }[] } }>(token, "query { projects(first: 100) { nodes { id name teams { nodes { id } } } } }");
    return d.projects.nodes.map((p) => ({ id: p.id, name: p.name, teamIds: p.teams.nodes.map((t) => t.id) }));
  }

  async teams(token: string) {
    const d = await this.gql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(token, "query { teams(first: 50) { nodes { id key name } } }");
    return d.teams.nodes;
  }

  async issue(token: string, id: string): Promise<LinearIssue> {
    const d = await this.gql<{ issue: { id: string; identifier: string; title: string; description: string | null; url: string; priority: number; labels: { nodes: { name: string }[] }; project: { id: string; name: string } | null; team: { id: string } } }>(
      token,
      "query($id: String!) { issue(id: $id) { id identifier title description url priority labels { nodes { name } } project { id name } team { id } } }",
      { id },
    );
    const i = d.issue;
    return {
      id: i.id, identifier: i.identifier, title: i.title, description: i.description ?? "", url: i.url, priority: i.priority,
      labels: i.labels.nodes.map((l) => l.name), projectId: i.project?.id ?? null, projectName: i.project?.name ?? null, teamId: i.team.id,
    };
  }

  async states(token: string, teamId: string) {
    const d = await this.gql<{ team: { states: { nodes: LinearState[] } } }>(token, "query($id: String!) { team(id: $id) { states { nodes { id name type } } } }", { id: teamId });
    return d.team.states.nodes;
  }

  async updateIssue(token: string, id: string, input: { stateId?: string; projectId?: string }) {
    await this.gql(token, "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id, input });
  }

  async createProject(token: string, name: string, teamIds: string[]) {
    const d = await this.gql<{ projectCreate: { project: { id: string } } }>(token, "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }", { input: { name, teamIds } });
    return { id: d.projectCreate.project.id };
  }

  async createActivity(token: string, sessionId: string, content: ActivityContent, opts: ActivityOptions = {}) {
    const input: Record<string, unknown> = { agentSessionId: sessionId, content, ...(opts.ephemeral ? { ephemeral: true } : {}) };
    if (opts.select?.length) Object.assign(input, { signal: "select", signalMetadata: { options: opts.select } });
    await this.gql(token, "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }", { input });
  }

  async updateSession(token: string, sessionId: string, input: { plan?: readonly PlanStep[]; externalUrls?: readonly { label: string; url: string }[] }) {
    await this.gql(token, "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }", { id: sessionId, input });
  }

  async token(params: Record<string, string>): Promise<LinearTokens> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
    if (!res.ok || !body?.access_token) throw new LinearError(`Linear sign-in failed: ${body?.error_description ?? body?.error ?? res.status}`);
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: Date.now() + (body.expires_in ?? 86_400) * 1000 };
  }
}
