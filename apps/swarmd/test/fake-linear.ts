import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ActivityContent, ActivityOptions, LinearApi, LinearIssue, LinearState, LinearTokens, PlanStep } from "../src/linear/linear-client.ts";

export const OWNER_ID = "user-owner";
export const OTHER_ID = "user-other";
export const TEAM = "team-zac";
export const WEBHOOK_SECRET = "whsec-test-0123456789abcdef";

export interface Activity {
  readonly sessionId: string;
  readonly content: ActivityContent;
  readonly opts: ActivityOptions;
}

/** Linear without Linear: records what agentSwarm sends, and plays the person's side through signed webhooks. */
export class FakeLinear implements LinearApi {
  readonly issues = new Map<string, LinearIssue>();
  readonly activities: Activity[] = [];
  readonly sessionUpdates: { sessionId: string; plan?: readonly PlanStep[]; externalUrls?: readonly { label: string; url: string }[] }[] = [];
  readonly issueStates = new Map<string, string>();
  readonly createdProjects: { id: string; name: string }[] = [];
  readonly tokenCalls: Record<string, string>[] = [];
  /** The next N activity posts fail (a Linear outage). */
  failActivities = 0;
  private n = 0;

  readonly workflow: LinearState[] = [
    { id: "st-todo", name: "Todo", type: "unstarted" },
    { id: "st-progress", name: "In Progress", type: "started" },
    { id: "st-review", name: "In Review", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    { id: "st-canceled", name: "Canceled", type: "canceled" },
  ];

  addIssue(input: Partial<LinearIssue> & { title: string }): LinearIssue {
    const n = ++this.n;
    const issue: LinearIssue = {
      id: `issue-${n}`, identifier: `ZAC-${n}`, description: "", url: `https://linear.app/zac/issue/ZAC-${n}`, priority: 3, labels: [],
      projectId: null, projectName: null, teamId: TEAM, ...input,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  in(sessionId: string): Activity[] {
    return this.activities.filter((a) => a.sessionId === sessionId);
  }

  stateOf(issueId: string): string | undefined {
    return this.workflow.find((s) => s.id === this.issueStates.get(issueId))?.name;
  }

  async viewer() {
    return { id: "app-user", name: "agentSwarm", organization: "Zac" };
  }
  async users() {
    return [{ id: OWNER_ID, name: "Zac", email: "zac@example.com" }, { id: OTHER_ID, name: "Someone", email: "someone@example.com" }];
  }
  async projects() {
    return [{ id: "lp-demo", name: "Demo", teamIds: [TEAM] }, { id: "lp-sandbox", name: "Sandbox", teamIds: [TEAM] }, { id: "lp-ideas", name: "Ideas", teamIds: [TEAM] }];
  }
  async teams() {
    return [{ id: TEAM, key: "ZAC", name: "Zac" }];
  }
  async issue(_token: string, id: string) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
  async states(_token: string, teamId: string) {
    if (teamId !== TEAM) throw new Error("no team");
    return this.workflow;
  }
  async updateIssue(_token: string, id: string, input: { stateId?: string; projectId?: string }) {
    if (input.stateId) this.issueStates.set(id, input.stateId);
    if (input.projectId) {
      const i = this.issues.get(id);
      if (i) this.issues.set(id, { ...i, projectId: input.projectId });
    }
  }
  async createProject(_token: string, name: string) {
    const p = { id: `lp-new-${this.createdProjects.length + 1}`, name };
    this.createdProjects.push(p);
    return { id: p.id };
  }
  async createActivity(_token: string, sessionId: string, content: ActivityContent, opts: ActivityOptions = {}) {
    if (this.failActivities > 0) {
      this.failActivities--;
      throw new Error("Linear is unavailable");
    }
    this.activities.push({ sessionId, content, opts });
  }
  async updateSession(_token: string, sessionId: string, input: { plan?: readonly PlanStep[]; externalUrls?: readonly { label: string; url: string }[] }) {
    this.sessionUpdates.push({ sessionId, ...input });
  }
  async token(params: Record<string, string>): Promise<LinearTokens> {
    this.tokenCalls.push(params);
    const n = this.tokenCalls.length;
    return { accessToken: `lin-access-${n}`, refreshToken: `lin-refresh-${n}`, expiresAt: Date.now() + 86_400_000 };
  }
}

/** Posts a signed Linear webhook to agentSwarm's webhook app, as Linear would. */
export async function webhook(app: FastifyInstance, payload: Record<string, unknown>, opts: { secret?: string; delivery?: string; at?: number } = {}): Promise<number> {
  const body = JSON.stringify({ webhookTimestamp: opts.at ?? Date.now(), webhookId: "wh-1", ...payload });
  const signature = createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(body).digest("hex");
  const res = await app.inject({
    method: "POST", url: "/linear/webhook", payload: body,
    headers: { "content-type": "application/json; charset=utf-8", "linear-signature": signature, "linear-delivery": opts.delivery ?? crypto.randomUUID(), "linear-event": "AgentSessionEvent" },
  });
  return res.statusCode;
}

export const created = (sessionId: string, issueId: string, creator = OWNER_ID) => ({
  type: "AgentSessionEvent", action: "created", agentSession: { id: sessionId, issue: { id: issueId }, creator: { id: creator } }, promptContext: "",
});

export const prompted = (sessionId: string, body: string, signal?: string, user = OWNER_ID) => ({
  type: "AgentSessionEvent", action: "prompted", agentSession: { id: sessionId }, agentActivity: { body, ...(signal ? { signal } : {}), user: { id: user } },
});
