import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExecEnv, Layout } from "@agentswarm/ws-exec";
import type { FastifyInstance } from "fastify";
import { openDatabase, type DbHandle } from "../src/db/client.ts";
import { SecretBox } from "../src/crypto/secret-box.ts";
import { createServices, type Services } from "../src/app/services.ts";
import { buildApp, SESSION_COOKIE } from "../src/http/app.ts";
import { LocalBackend } from "../src/workstations/backend.ts";
import { createGitRunner } from "../src/github/git.ts";
import { type GitHubClient, type PullRequestState } from "../src/github/github-client.ts";
import type { WebAccess } from "../src/web/web-access.ts";
import { FakeDiscord } from "./fake-discord.ts";
import type { RunLimits } from "../src/db/schema.ts";
import { installFakeCli, type FakeCli } from "../../../packages/ws-exec/test/fake-cli.ts";
import { installFakeSim, type FakeSim } from "../../../packages/ws-exec/test/fake-sim.ts";

const LOCAL_MAIN = fileURLToPath(new URL("../../../packages/ws-exec/src/local-main.ts", import.meta.url));
export const ADMIN = { username: "admin", password: "correct horse battery staple" };

export interface Harness {
  readonly base: string;
  readonly layout: Layout;
  readonly remote: string;
  readonly services: Services;
  readonly app: FastifyInstance;
  readonly db: DbHandle;
  readonly protectedBranches: Set<string>;
  readonly pullRequests: { repo: string; head: string; base: string; title: string; body: string }[];
  /** What the fake GitHub says about pull request N (default open). */
  readonly prStates: Map<number, PullRequestState>;
  readonly discord: FakeDiscord;
  /** Fake `claude` and `codex` the CLI runs use (R4). */
  readonly cli: FakeCli;
  /** Fake simctl, AXe and xcodebuild (R6), per workstation user. */
  sim(user: string): FakeSim;
  /** Pages web_fetch can read, by URL; web_search answers with `searchResult`. */
  readonly web: { pages: Map<string, string>; searches: string[]; searchResult: string };
  /** Scripted model replies, consumed one per model request. */
  script(steps: FauxResponseStep[]): void;
  /** One script per agent name (read from "You are <name>," in the system prompt); order across agents does not matter. */
  scriptAgents(scripts: Record<string, FauxResponseStep[]>): { remaining(): string[] };
  pending(): number;
  /** Signs in (running first-time setup) and returns a cookie header. */
  login(): Promise<string>;
  api<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, cookie?: string): Promise<{ status: number; body: T }>;
  /** Token, project, endpoint and one agent, ready to run. */
  ready(): Promise<{ cookie: string; projectId: string; agentId: string }>;
  remoteBranches(): string[];
  close(): Promise<void>;
}

/** A buggy module and its failing test, published as the "GitHub" remote. */
function makeRemote(base: string): string {
  const src = join(base, "remote-src");
  mkdirSync(src);
  writeFileSync(join(src, "math.js"), "export const square = (x) => x + x;\n");
  writeFileSync(join(src, "math.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { square } from "./math.js";\ntest("square", () => assert.equal(square(3), 9));\n');
  writeFileSync(join(src, "package.json"), '{ "type": "module" }\n');
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  const remote = join(base, "github", "demo.git");
  mkdirSync(join(base, "github"));
  git(base, "clone", "-q", "--bare", src, remote);
  return remote;
}

export async function harness(opts: { limits?: RunLimits; maxConcurrentRuns?: number; webDist?: string; prPollMs?: number; heavySlots?: number; memoryPressure?: () => number } = {}): Promise<Harness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "swarmd-test-")));
  const volume = join(base, "SwarmWS");
  const layout: Layout = {
    volume, wsRoot: join(volume, "ws"), mirrors: join(volume, "mirrors"), inbox: join(volume, "inbox"),
    swarmdData: join(volume, "swarmd"), nodeBin: process.execPath.replace(/\/node$/, ""), swarmdPort: 4318, cliDir: join(base, "cli"), toolsDir: join(base, "tools"), xcrun: join(base, "tools", "fake-xcrun"),
  };
  const envs = new Map<string, ExecEnv>();
  const sims = new Map<string, FakeSim>();
  for (const user of ["ws-1", "ws-2"]) {
    const env: ExecEnv = { user, home: join(base, "homes", user), root: join(layout.wsRoot, user), layout, sandbox: true, reapAll: false };
    for (const d of [env.home, env.root, join(layout.inbox, `${user}.git`)]) mkdirSync(d, { recursive: true });
    envs.set(user, env);
    sims.set(user, installFakeSim(layout, join(env.root, "cache")));
  }
  mkdirSync(layout.mirrors, { recursive: true });
  mkdirSync(layout.swarmdData, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.wsRoot, "ws-2", "secret.txt"), "ws-2 only\n");
  const remote = makeRemote(base);
  const cli = installFakeCli(layout.cliDir);
  // "GitHub" repositories by full name; new ones appear when a test creates them (R5: ideas become projects).
  const remotes = new Map<string, string>([["tester/demo", remote]]);

  const faux = createFauxCore({ models: [{ id: "fake-model", input: ["text", "image"] }] });
  const protectedBranches = new Set<string>();
  const pullRequests: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  const prStates = new Map<number, PullRequestState>();
  const discord = new FakeDiscord();
  const webState = { pages: new Map<string, string>(), searches: [] as string[], searchResult: "Results:\n1. Example\n   https://example.com/csv\n   CSV parsing notes" };
  const web: WebAccess = {
    fetch: async (url) => {
      const text = webState.pages.get(url);
      if (text === undefined) throw new Error(`no such page ${url}`);
      return { url, status: 200, title: "Page", text };
    },
    search: async (query) => {
      webState.searches.push(query);
      return { text: webState.searchResult, costUsd: 0.007 };
    },
  };
  const github: GitHubClient = {
    whoami: async () => ({ login: "tester", expiresAt: null }),
    repo: async (_t, fullName) => {
      if (!remotes.has(fullName) && fullName !== "tester/demo") throw new Error(`no repository ${fullName}`);
      return { fullName, defaultBranch: "main", private: true, canAdmin: true, cloneUrl: remotes.get(fullName) ?? remote };
    },
    listRepos: async () => [...remotes.keys()].map((fullName) => ({ fullName, private: true, description: "", updatedAt: new Date().toISOString() })),
    createRepo: async (_t, name) => {
      const fullName = `tester/${name}`;
      const path = join(base, "github", `${name}.git`);
      execFileSync("/usr/bin/git", ["init", "-q", "--bare", "-b", "main", path]);
      remotes.set(fullName, path);
      return { fullName };
    },
    isProtected: async (_t, fullName, branch) => protectedBranches.has(`${fullName}:${branch}`),
    protect: async (_t, fullName, branch) => void protectedBranches.add(`${fullName}:${branch}`),
    createPullRequest: async (_t, fullName, input) => {
      pullRequests.push({ repo: fullName, ...input });
      return `https://github.com/${fullName}/pull/${pullRequests.length}`;
    },
    pullRequestState: async (_t, _fullName, number) => prStates.get(number) ?? "open",
    deleteBranch: async () => {
      throw new Error("the test remote is local; branches are deleted with git");
    },
  };
  const db = openDatabase(":memory:");
  const services = createServices({
    db: db.db,
    secrets: await SecretBox.fromRawKey(randomBytes(32)),
    backend: new LocalBackend(envs, LOCAL_MAIN),
    githubClient: github,
    git: createGitRunner({ askpassDir: base, inboxGlob: `${layout.inbox}/*` }),
    layout,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 2,
    screensDir: join(base, "screens"),
    attachmentsDir: join(base, "attachments"),
    ...(opts.heavySlots ? { heavySlots: opts.heavySlots } : {}),
    // Normal unless a test says otherwise: the host's own memory must not decide whether a test passes.
    memoryPressure: opts.memoryPressure ?? (() => 1),
    log: () => {},
    gateway: () => ({
      listModels: async () => [{ id: "fake-model", name: "Fake", vision: true, contextWindow: 100_000, inputPerMTok: 0, outputPerMTok: 0 }],
      resolve: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
    }),
    remoteUrl: (fullName) => remotes.get(fullName) ?? remote,
    refreshMirror: false,
    ...(opts.limits ? { limits: opts.limits } : {}),
    web: () => web,
    transport: discord,
    dashboardUrl: "http://127.0.0.1:4399",
    ...(opts.prPollMs ? { prPollMs: opts.prPollMs } : {}),
  });
  await services.pool.sync();
  const app = await buildApp({ services, webDist: opts.webDist ?? null, check: { dataDir: layout.swarmdData, volume: null }, allowedHosts: ["localhost:80", "127.0.0.1:4399"] });

  const api: Harness["api"] = async (method, url, body, cookie) => {
    const res = await app.inject({
      method, url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const login = async () => {
    const setup = await app.inject({ method: "GET", url: "/api/setup" });
    const path = JSON.parse(setup.body).required ? "/api/setup" : "/api/auth/login";
    const res = await app.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: JSON.stringify(ADMIN) });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return `${SESSION_COOKIE}=${cookie.value}`;
  };

  return {
    sim: (user) => sims.get(user)!,
    base, layout, remote, services, app, db, protectedBranches, pullRequests, prStates, discord, cli, web: webState,
    script: (steps) => faux.setResponses(steps),
    scriptAgents(scripts) {
      const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
      const router: FauxResponseFactory = (context, options, state, model) => {
        const system = context.messages.find((m) => m.role === "system") as { content: unknown } | undefined;
        const text = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
        const name = /You are ([^,]+),/.exec(text)?.[1] ?? "?";
        const step = queues.get(name)?.shift();
        if (!step) return fauxAssistantMessage(fauxText(`(no script left for ${name})`));
        return typeof step === "function" ? step(context, options, state, model) : step;
      };
      faux.setResponses(Array.from({ length: 500 }, () => router));
      return { remaining: () => [...queues].filter(([, q]) => q.length).map(([k, q]) => `${k}:${q.length}`) };
    },
    pending: () => faux.getPendingResponseCount(),
    login,
    api,
    async ready() {
      const cookie = await login();
      await api("PUT", "/api/github", { token: "github_pat_test_token_value_123456" }, cookie);
      const project = await api("POST", "/api/projects", { githubRepo: "tester/demo" }, cookie);
      if (project.status !== 200) throw new Error(`project: ${JSON.stringify(project.body)}`);
      const endpoint = await api("POST", "/api/endpoints", { name: "Fake", kind: "openrouter", apiKey: "sk-or-test-key" }, cookie);
      const agent = await api("POST", "/api/agents", { name: "Dev", projectId: project.body.id, role: "developer", endpointId: endpoint.body.id, modelId: "fake-model" }, cookie);
      if (agent.status !== 200) throw new Error(`agent: ${JSON.stringify(agent.body)}`);
      return { cookie, projectId: project.body.id, agentId: agent.body.id };
    },
    remoteBranches: () => execFileSync("/usr/bin/git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: remote }).toString().trim().split("\n"),
    async close() {
      services.watcher.stop();
      await services.discord.stop();
      await services.runs.stopAll();
      await app.close();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
