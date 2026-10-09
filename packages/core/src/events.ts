import type { Agent, AgentState } from "./contracts/agents.ts";
import type { Channel, Message, QueueInfo } from "./contracts/chat.ts";
import type { ActivityEvent, Run } from "./contracts/runs.ts";
import type { GitPush, HostStatus, Workstation, Worktree } from "./contracts/workstations.ts";
import type { Task } from "./contracts/tasks.ts";

// One WebSocket carries every server event. Clients reconnect by refetching snapshots
// over HTTP and then applying these increments; runs never depend on a live socket.
export type ServerEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "channel.updated"; channel: Channel }
  | { type: "channel.deleted"; channelId: string }
  | { type: "run.updated"; run: Run }
  | { type: "activity.created"; activity: ActivityEvent }
  | { type: "agent.state"; agentId: string; state: AgentState; queue?: QueueInfo }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "workstation.updated"; workstation: Workstation }
  | { type: "worktree.updated"; worktree: Worktree }
  | { type: "git.pushed"; push: GitPush }
  | { type: "host.updated"; host: HostStatus }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string };

export type ServerEventType = ServerEvent["type"];
