import type { Layout } from "@agentswarm/ws-exec";
import { memoryPressure } from "../system/memory.ts";
import { TicketService } from "../tickets/ticket-service.ts";
import { Attachments } from "../tickets/attachments.ts";
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
import { TreeCleanup } from "../agents/cleanup.ts";
import { PullRequestWatcher } from "../github/pr-watcher.ts";
import { MissionService } from "../missions/mission-service.ts";
import { createWebAccess, type WebAccess } from "../web/web-access.ts";
import { DiscordBridge } from "../discord/bridge.ts";
import type { ChatTransport } from "../discord/transport.ts";
import { CliService } from "../cli/cli-service.ts";
import { MachineService } from "../system/machine.ts";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface ServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly backend: WorkstationBackend;
  readonly githubClient: GitHubClient;
  readonly git: GitRunner;
  readonly layout: Pick<Layout, "mirrors" | "inbox">;
  readonly maxConcurrentRuns: number;
  /** R6: runs with a simulator or browser at once (default 2). */
  readonly heavySlots?: number;
  /** R6: where runs' screenshots are kept for the dashboard. */
  readonly screensDir: string;
  /** R7: where tickets' pictures are kept. */
  readonly attachmentsDir: string;
  /** R6: tests pretend memory is tight. */
  readonly memoryPressure?: () => number;
  readonly log: Logger;
  /** Tests inject a scripted model; production talks to the configured endpoints. */
  readonly gateway?: (endpoints: EndpointService) => ModelGateway;
  readonly remoteUrl?: (fullName: string) => string;
  readonly refreshMirror?: boolean;
  readonly limits?: RunLimits;
  /** Tests fake the web and Discord; production uses the real ones. */
  readonly web?: (endpoints: EndpointService) => WebAccess;
  readonly transport: ChatTransport;
  /** Links in Discord messages point here. */
  readonly dashboardUrl: string;
  readonly prPollMs?: number;
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
  readonly cleanup: TreeCleanup;
  readonly missions: MissionService;
  readonly watcher: PullRequestWatcher;
  readonly discord: DiscordBridge;
  readonly cli: CliService;
  readonly machine: MachineService;
  readonly tickets: TicketService;
}

export function createServices(d: ServiceDeps): Services {
  const bus = new EventBus(d.db);
  const endpoints = new EndpointService(d.db, d.secrets);
  const gateway = d.gateway?.(endpoints) ?? new PiModelGateway(endpoints);
  const github = new GitHubService(d.db, d.secrets, d.githubClient);
  const projects = new ProjectService({ db: d.db, github, git: d.git, mirrorsDir: d.layout.mirrors, secrets: d.secrets, ...(d.remoteUrl ? { remoteUrl: d.remoteUrl } : {}) });
  const pool = new WorkstationPool(d.db, d.backend, (workstation) => bus.publish({ kind: "workstation", workstation }));
  const agents = new AgentService(d.db);
  const relay = new Relay({ db: d.db, backend: d.backend, projects, git: d.git, bus, layout: d.layout });
  // A workstation the CLI service held (sign-in, test) is free again: let queued runs have it.
  const cli = new CliService({ db: d.db, secrets: d.secrets, backend: d.backend, pool, bus, log: (msg, extra) => d.log("warn", msg, extra), onFreed: () => runs.schedule() });
  const tree = new TreeService({ db: d.db, projects, agents, github, git: d.git, backend: d.backend, limits: d.limits ?? DEFAULT_LIMITS });
  const runs = new RunService({
    db: d.db, bus, pool, backend: d.backend, projects, agents, gateway, relay, tree, cli,
    maxConcurrent: d.maxConcurrentRuns, refreshMirror: d.refreshMirror ?? true,
    heavySlots: d.heavySlots ?? 2, memoryPressure: d.memoryPressure ?? memoryPressure, screensDir: d.screensDir,
    log: (msg, extra) => d.log("warn", msg, extra),
    ...(d.limits ? { limits: d.limits } : {}),
  });
  const warn = (msg: string, extra?: Record<string, unknown>) => d.log("warn", msg, extra);
  const cleanup = new TreeCleanup({ db: d.db, backend: d.backend, projects, github, git: d.git, log: warn, isActive: (id) => runs.isActive(id) });
  const missions = new MissionService({
    db: d.db, bus, runs, tree, projects, agents, git: d.git, web: d.web?.(endpoints) ?? createWebAccess(endpoints), cleanup, log: warn,
  });
  runs.attach(missions);
  const watcher = new PullRequestWatcher({
    db: d.db, github, log: warn, ...(d.prPollMs ? { intervalMs: d.prPollMs } : {}),
    // Ended missions whose cleanup never finished (a timeout, a restart, an unhealthy workstation).
    sweep: () => missions.sweep(),
    settle: async (root, state) => {
      if (root.missionId) return missions.pullRequestSettled(root, state);
      await cleanup.clean(root.treeId!);
    },
  });
  const discord = new DiscordBridge({ db: d.db, secrets: d.secrets, bus, missions, projects, transport: d.transport, dashboardUrl: d.dashboardUrl, log: warn, quota: () => cli.quota() });
  const tickets = new TicketService({
    db: d.db, bus, missions, projects, agents, runs, tree, github, git: d.git, attachments: new Attachments(d.db, d.attachmentsDir), log: warn,
    notify: (t, what) => discord.notifyTicket(t, what),
  });
  return { bus, auth: new AuthService(d.db), endpoints, gateway, github, projects, pool, agents, relay, runs, tree, cleanup, missions, watcher, discord, cli, machine: new MachineService(d.db, d.layout.mirrors), tickets };
}
