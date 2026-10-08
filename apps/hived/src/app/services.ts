import { createCommunicationPack, ToolpackRegistry } from "@hive/tools";
import type { Db } from "../db/client.ts";
import type { SecretBox } from "../crypto/secret-box.ts";
import { AuthService } from "../auth/auth-service.ts";
import { EndpointService } from "../endpoints/endpoint-service.ts";
import { AgentService } from "../agents/agent-service.ts";
import { AgentManager, type ManagerLimits } from "../agents/agent-manager.ts";
import type { AgentRuntime } from "../agents/runtime/agent-runtime.ts";
import { ChatService } from "../chat/chat-service.ts";
import { EventBus } from "../events/event-bus.ts";
import { RunStore } from "../runs/run-store.ts";

export type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export interface ServiceDeps {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly runtime: AgentRuntime;
  readonly log: Logger;
  readonly limits?: Partial<ManagerLimits>;
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

  const agents = new AgentService({
    db,
    endpointExists: (orgId, id) => endpoints.exists(orgId, id),
    toolpackExists: (id) => registry.has(id),
    stateOf: (id) => requireManager().stateOf(id),
  });

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
  });

  const services = { db, bus, auth, endpoints, agents, chat, runs, registry, manager };
  return {
    ...services,
    async start() {
      await registry.refreshHealth();
      requireManager().recover();
    },
  };
}
