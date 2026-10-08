import type { Agent, AgentState } from "./contracts/agents.ts";
import type { Message } from "./contracts/chat.ts";
import type { ActivityEvent, Run } from "./contracts/runs.ts";
import type { GitPush, HostStatus, Workstation, Worktree } from "./contracts/workstations.ts";

// One WebSocket carries every server event. Clients reconnect by refetching snapshots
// over HTTP and then applying these increments; runs never depend on a live socket.
export type ServerEvent =
  | { type: "message.created"; message: Message }
  | { type: "run.updated"; run: Run }
  | { type: "activity.created"; activity: ActivityEvent }
  | { type: "agent.state"; agentId: string; state: AgentState }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "workstation.updated"; workstation: Workstation }
  | { type: "worktree.updated"; worktree: Worktree }
  | { type: "git.pushed"; push: GitPush }
  | { type: "host.updated"; host: HostStatus };

export type ServerEventType = ServerEvent["type"];
