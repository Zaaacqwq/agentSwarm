import { createCommunicationPack, ToolpackRegistry } from "@hive/tools";
import { eq } from "drizzle-orm";
import type { ServerEvent } from "@hive/core";
import { schema, type Db } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { AuthService } from "../auth/auth-service.ts";
import { EndpointService } from "../endpoints/endpoint-service.ts";
import { AgentService } from "../agents/agent-service.ts";
import { AgentManager, type ManagerLimits } from "../agents/agent-manager.ts";
import type { AgentRuntime } from "../agents/runtime/agent-runtime.ts";
import { ChatService } from "../chat/chat-service.ts";
import { EventBus } from "../events/event-bus.ts";
import { RunStore } from "../runs/run-store.ts";
import { createWorkstationPack } from "@hive/tools";
import type { WorkstationBackend } from "../workstations/backend.ts";
import { WorkstationService } from "../workstations/workstation-service.ts";
import { WorkstationAdapter } from "../workstations/workstation-adapter.ts";
import { LeaseService } from "../leases/lease-service.ts";
import { HeavySlots } from "../leases/heavy-slots.ts";
import { RepoService } from "../repos/repo-service.ts";
import { runGit, type GitRunner } from "../repos/git-cli.ts";
import { GitRelay } from "../git-relay/relay.ts";
import { ghCli, type GitHubPort } from "../git-relay/github.ts";
import { HostMonitor, macProbe, type HostProbe } from "../host/host-monitor.ts";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface ServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly runtime: AgentRuntime;
  readonly log: Logger;
  readonly limits?: Partial<ManagerLimits>;
  readonly backend: WorkstationBackend;
  readonly git?: GitRunner;
  readonly github?: GitHubPort;
  readonly hostProbe?: HostProbe;
  readonly heavySlots?: number;
}

export interface Services {
  readonly db: Db;
  readonly bus: EventBus;
  readonly auth: AuthService;
  readonly endpoints: EndpointService;
  readonly agents: AgentService;
  readonly chat: ChatService;
  readonly runs: RunStore;
  readonly registry: ToolpackRegistry;
  readonly manager: AgentManager;
  readonly workstations: WorkstationService;
  readonly repos: RepoService;
  readonly leases: LeaseService;
  readonly heavy: HeavySlots;
  readonly relay: GitRelay;
  readonly host: HostMonitor;
}

/** Composition root. Construction has no side effects; call start() before serving. */
export function createServices(deps: ServiceDeps): Services & { start(): Promise<void> } {
  const { db, log } = deps;
  const bus = new EventBus((error) => log("error", "event listener failed", { error: String(error) }));
  const registry = new ToolpackRegistry();
  const runs = new RunStore(db);
  const auth = new AuthService(db);
  const endpoints = new EndpointService(db, deps.secrets);

  // The manager is created last; these closures only run after construction finishes.
  let manager: AgentManager | null = null;
  const requireManager = (): AgentManager => {
    if (!manager) throw new Error("AgentManager not initialised");
    return manager;
  };

  // Workstations (P2). The manager is referenced lazily by closures below.
  let workstations: WorkstationService | null = null;
  const leases = new LeaseService(db, (resourceId) => publishWorkstation(resourceId));
  workstations = new WorkstationService(db, deps.backend, leases);
  const git = deps.git ?? runGit;
  const repos = new RepoService({ db, backend: deps.backend, git, onWorktree: (wt) => publishForWorkstation(wt.workstationId, { type: "worktree.updated", worktree: wt }) });
  const relay = new GitRelay({ db, backend: deps.backend, repos, git, github: deps.github ?? ghCli, onPush: (push) => publishForAgent(push.agentId, { type: "git.pushed", push }) });
  let host: HostMonitor | null = null;
  const heavy = new HeavySlots(deps.heavySlots ?? 2, () => host?.underPressure() ?? false);

  const agents = new AgentService({
    db,
    endpointExists: (orgId, id) => endpoints.exists(orgId, id),
    toolpackExists: (id) => registry.has(id),
    stateOf: (id) => requireManager().stateOf(id),
    workstationOf: (id) => workstations?.workstationIdOf(id) ?? null,
  });

  function orgOfWorkstation(id: string): string | null {
    return db.select({ o: schema.workstations.orgId }).from(schema.workstations).where(eq(schema.workstations.id, id)).get()?.o ?? null;
  }
  function publishWorkstation(workstationId: string): void {
    const orgId = orgOfWorkstation(workstationId);
    if (orgId && workstations) bus.publish(orgId, { type: "workstation.updated", workstation: workstations.get(orgId, workstationId) });
  }
  function publishForWorkstation(workstationId: string, event: ServerEvent): void {
    const orgId = orgOfWorkstation(workstationId);
    if (orgId) bus.publish(orgId, event);
  }
  function publishForAgent(agentId: string, event: ServerEvent): void {
    const orgId = agents.findRow(agentId)?.orgId;
    if (orgId) bus.publish(orgId, event);
  }

  const chat = new ChatService({
    db,
    bus,
    agentInOrg: (orgId, agentId) => agents.exists(orgId, agentId),
    agentStateOf: (id) => requireManager().stateOf(id),
    onHumanMessage: ({ orgId, messageId, agentIds }) => {
      for (const agentId of agentIds) requireManager().notify(orgId, agentId, messageId);
    },
  });

  registry.register(createCommunicationPack(chat));
  const adapter = new WorkstationAdapter({
    workstations, repos, leases, heavy, relay,
    findAgent: (id) => agents.findRow(id),
    agentName: (id) => agents.findRow(id)?.name ?? "another agent",
  });
  registry.register(createWorkstationPack(adapter, async () => {
    const h = await deps.backend.health();
    return h.ready ? { available: true } : { available: false, reason: h.reason ?? "workstations unavailable" };
  }));
  host = new HostMonitor({
    probe: deps.hostProbe ?? macProbe,
    mounts: ["/", deps.backend.layout.volume],
    heavyStats: () => heavy.stats(),
    workstations: () => deps.backend.health(),
    onChange: (status) => {
      heavy.drain();
      for (const org of db.select({ id: schema.organizations.id }).from(schema.organizations).all()) bus.publish(org.id, { type: "host.updated", host: status });
    },
  });

  manager = new AgentManager({
    runs,
    bus,
    registry,
    runtime: deps.runtime,
    findAgent: (id) => agents.findRow(id),
    grantsOf: (id) => agents.grantsOf(id),
    resolveEndpoint: (orgId, id) => endpoints.resolveForRun(orgId, id),
    chat,
    log,
    ...(deps.limits ? { limits: deps.limits } : {}),
    onRunSettled: (runId) => leases.releaseForRun(runId),
  });

  const services = { db, bus, auth, endpoints, agents, chat, runs, registry, manager, workstations, repos, leases, heavy, relay, host };
  return {
    ...services,
    async start() {
      await registry.refreshHealth();
      // Leases belong to runs; after a restart no run is active, so none can still be held.
      leases.releaseAll();
      requireManager().recover();
    },
  };
}
