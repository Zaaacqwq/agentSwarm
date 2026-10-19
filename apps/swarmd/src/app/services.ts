import type { Layout } from "@agentswarm/ws-exec";
import type { Db } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { AuthService } from "../auth/auth-service.ts";
import { EndpointService } from "../endpoints/endpoint-service.ts";
import { PiModelGateway, type ModelGateway } from "../models/model-gateway.ts";
import type { GitHubClient } from "../github/github-client.ts";
import { GitHubService } from "../github/github-service.ts";
import type { GitRunner } from "../github/git.ts";
import { ProjectService } from "../projects/project-service.ts";
import { WorkstationPool } from "../workstations/pool.ts";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { EventBus } from "../events/event-bus.ts";
import { Relay } from "../relay/relay.ts";
import { AgentService } from "../agents/agent-service.ts";
import { DEFAULT_LIMITS, RunService } from "../agents/run-service.ts";
import { TreeService } from "../agents/tree-service.ts";
import type { RunLimits } from "../db/schema.ts";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface ServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly backend: WorkstationBackend;
  readonly githubClient: GitHubClient;
  readonly git: GitRunner;
  readonly layout: Pick<Layout, "mirrors" | "inbox">;
  readonly maxConcurrentRuns: number;
  readonly log: Logger;
  /** Tests inject a scripted model; production talks to the configured endpoints. */
  readonly gateway?: (endpoints: EndpointService) => ModelGateway;
  readonly remoteUrl?: (fullName: string) => string;
  readonly refreshMirror?: boolean;
  readonly limits?: RunLimits;
}

export interface Services {
  readonly bus: EventBus;
  readonly auth: AuthService;
  readonly endpoints: EndpointService;
  readonly gateway: ModelGateway;
  readonly github: GitHubService;
  readonly projects: ProjectService;
  readonly pool: WorkstationPool;
  readonly agents: AgentService;
  readonly relay: Relay;
  readonly runs: RunService;
  readonly tree: TreeService;
}

export function createServices(d: ServiceDeps): Services {
  const bus = new EventBus(d.db);
  const endpoints = new EndpointService(d.db, d.secrets);
  const gateway = d.gateway?.(endpoints) ?? new PiModelGateway(endpoints);
  const github = new GitHubService(d.db, d.secrets, d.githubClient);
  const projects = new ProjectService({ db: d.db, github, git: d.git, mirrorsDir: d.layout.mirrors, ...(d.remoteUrl ? { remoteUrl: d.remoteUrl } : {}) });
  const pool = new WorkstationPool(d.db, d.backend, (workstation) => bus.publish({ kind: "workstation", workstation }));
  const agents = new AgentService(d.db);
  const relay = new Relay({ db: d.db, backend: d.backend, projects, git: d.git, bus, layout: d.layout });
  const tree = new TreeService({ db: d.db, projects, agents, github, git: d.git, backend: d.backend, limits: d.limits ?? DEFAULT_LIMITS });
  const runs = new RunService({
    db: d.db, bus, pool, backend: d.backend, projects, agents, gateway, relay, tree,
    maxConcurrent: d.maxConcurrentRuns, refreshMirror: d.refreshMirror ?? true,
    log: (msg, extra) => d.log("warn", msg, extra),
    ...(d.limits ? { limits: d.limits } : {}),
  });
  return { bus, auth: new AuthService(d.db), endpoints, gateway, github, projects, pool, agents, relay, runs, tree };
}
