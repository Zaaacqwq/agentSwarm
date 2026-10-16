import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExecEnv, Layout } from "@hive/ws-exec";
import type { FastifyInstance } from "fastify";
import { openDatabase, type DbHandle } from "../src/db/client.ts";
import { SecretBox } from "../src/crypto/secret-box.ts";
import { createServices, type Services } from "../src/app/services.ts";
import { buildApp, SESSION_COOKIE } from "../src/http/app.ts";
import { LocalBackend } from "../src/workstations/backend.ts";
import { createGitRunner } from "../src/github/git.ts";
import type { GitHubClient } from "../src/github/github-client.ts";
import type { RunLimits } from "../src/db/schema.ts";

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
  /** Scripted model replies, consumed one per model request. */
  script(steps: FauxResponseStep[]): void;
  pending(): number;
  /** Signs in (running first-time setup) and returns a cookie header. */
  login(): Promise<string>;
  api<T = any>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, cookie?: string): Promise<{ status: number; body: T }>;
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

export async function harness(opts: { limits?: RunLimits; maxConcurrentRuns?: number; webDist?: string } = {}): Promise<Harness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hived-test-")));
  const volume = join(base, "HiveWS");
  const layout: Layout = {
    volume, wsRoot: join(volume, "ws"), mirrors: join(volume, "mirrors"), inbox: join(volume, "inbox"),
    hivedData: join(volume, "hived"), nodeBin: process.execPath.replace(/\/node$/, ""),
  };
  const envs = new Map<string, ExecEnv>();
  for (const user of ["ws-1", "ws-2"]) {
    const env: ExecEnv = { user, home: join(base, "homes", user), root: join(layout.wsRoot, user), layout, sandbox: true };
    for (const d of [env.home, env.root, join(layout.inbox, `${user}.git`)]) mkdirSync(d, { recursive: true });
    envs.set(user, env);
  }
  mkdirSync(layout.mirrors, { recursive: true });
  mkdirSync(layout.hivedData, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.wsRoot, "ws-2", "secret.txt"), "ws-2 only\n");
  const remote = makeRemote(base);

  const faux = createFauxCore({ models: [{ id: "fake-model", input: ["text", "image"] }] });
  const protectedBranches = new Set<string>();
  const github: GitHubClient = {
    whoami: async () => ({ login: "tester", expiresAt: null }),
    repo: async (_t, fullName) => ({ fullName, defaultBranch: "main", private: true, canAdmin: true, cloneUrl: remote }),
    isProtected: async (_t, fullName, branch) => protectedBranches.has(`${fullName}:${branch}`),
    protect: async (_t, fullName, branch) => void protectedBranches.add(`${fullName}:${branch}`),
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
    log: () => {},
    gateway: () => ({
      listModels: async () => [{ id: "fake-model", name: "Fake", vision: true, contextWindow: 100_000, inputPerMTok: 0, outputPerMTok: 0 }],
      resolve: async () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
    }),
    remoteUrl: () => remote,
    refreshMirror: false,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  await services.pool.sync();
  const app = await buildApp({ services, webDist: opts.webDist ?? null, check: { dataDir: layout.hivedData, volume: null } });

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
    base, layout, remote, services, app, db, protectedBranches,
    script: (steps) => faux.setResponses(steps),
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
      await services.runs.stopAll();
      await app.close();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
