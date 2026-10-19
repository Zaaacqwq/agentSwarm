import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const text = (t: string, terminate = false): AgentToolResult<undefined> & { terminate?: boolean } => ({ content: [{ type: "text", text: t }], details: undefined, ...(terminate ? { terminate: true } : {}) });

/** What the tree tools ask of the run service, bound to the calling run. */
export interface TreeToolOps {
  spawn(input: { name: string; role: string; brief: string; budgetUsd?: number; modelId?: string }): Promise<{ id: string; branch: string; budgetUsd: number }>;
  /** Results right away if everything waited for has finished; otherwise null, and the run will suspend. */
  wait(ids: string[] | undefined): string | null;
  message(id: string, text: string): void;
  cancel(id: string): void;
  review(id: string): Promise<string>;
  merge(id: string, signal?: AbortSignal): Promise<string>;
  openPullRequest(title: string, body: string): Promise<string>;
}

const Spawn = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 30, description: "Short name, e.g. strings" }),
  role: Type.String({ minLength: 1, maxLength: 40, description: "e.g. developer" }),
  brief: Type.String({ minLength: 20, maxLength: 20_000, description: "The complete task; the sub-agent sees nothing else" }),
  budget_usd: Type.Optional(Type.Number({ minimum: 0.01, maximum: 50 })),
  model: Type.Optional(Type.String({ maxLength: 200 })),
});
const Ids = Type.Object({ ids: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })) });
const Id = Type.Object({ id: Type.String() });
const Message = Type.Object({ id: Type.String(), text: Type.String({ minLength: 1, maxLength: 20_000 }) });
const Pr = Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ maxLength: 20_000 }) });

/** Spawning and coordinating sub-agents. `canSpawn` is false at the depth limit; `isRoot` adds the PR tool. */
export function treeTools(ops: TreeToolOps, opts: { canSpawn: boolean; isRoot: boolean }): AgentTool<any, undefined>[] {
  // These change shared tree state: one at a time, even when the model asks for several at once.
  return build(ops, opts).map((t) => ({ ...t, executionMode: "sequential" as const }));
}

function build(ops: TreeToolOps, opts: { canSpawn: boolean; isRoot: boolean }): AgentTool<any, undefined>[] {
  const tools: AgentTool<any, undefined>[] = [];
  if (opts.canSpawn) {
    tools.push(
      {
        name: "spawn_agent", label: "spawn_agent", parameters: Spawn,
        description: "Give one part of the work to a new sub-agent with its own workstation, context and branch (cut from your last pushed commit). It starts right away. Commit and git_push first if it needs your changes.",
        execute: async (_id, p: any) => {
          const c = await ops.spawn({ name: p.name, role: p.role, brief: p.brief, ...(p.budget_usd ? { budgetUsd: p.budget_usd } : {}), ...(p.model ? { modelId: p.model } : {}) });
          return text(`Spawned ${p.name}: id ${c.id}, branch ${c.branch}, budget $${c.budgetUsd.toFixed(2)}. Spawn the others you need, then call wait_agents.`);
        },
      },
      {
        name: "wait_agents", label: "wait_agents", parameters: Ids,
        description: "Wait for sub-agents (default: all unfinished ones). Your turn ends and your workstation is freed; you are resumed with their reports.",
        execute: async (_id, p: any) => {
          const now = ops.wait(p.ids);
          return now === null ? text("Waiting. You will be resumed with their results.", true) : text(now);
        },
      },
      {
        name: "message_agent", label: "message_agent", parameters: Message,
        description: "Send more information or a correction to one of your sub-agents (it continues on its own branch).",
        execute: async (_id, p: any) => {
          ops.message(p.id, p.text);
          return text("Sent. Call wait_agents to get its new report.");
        },
      },
      {
        name: "cancel_agent", label: "cancel_agent", parameters: Id,
        description: "Cancel one of your sub-agents and everything it spawned.",
        execute: async (_id, p: any) => {
          ops.cancel(p.id);
          return text("Cancelled.");
        },
      },
      {
        name: "review_agent", label: "review_agent", parameters: Id,
        description: "Have a reviewer check a finished sub-agent's branch. Your turn ends; you are resumed with the verdict.",
        execute: async (_id, p: any) => text(`Reviewer ${await ops.review(p.id)} started. You will be resumed with the verdict.`, true),
      },
      {
        name: "merge_agent", label: "merge_agent", parameters: Id,
        description: "Merge an approved sub-agent's branch into your branch. Then run the tests and git_push.",
        execute: async (_id, p: any, signal) => text(await ops.merge(p.id, signal)),
      },
    );
  }
  if (opts.isRoot) {
    tools.push({
      name: "open_pull_request", label: "open_pull_request", parameters: Pr,
      description: "Open the pull request from your branch into the default branch, for a person to merge. Only when everything is merged, pushed and tested.",
      execute: async (_id, p: any) => text(`Opened ${await ops.openPullRequest(p.title, p.body)}. Now call report.`),
    });
  }
  return tools;
}

const Verdict = Type.Object({ approved: Type.Boolean(), comments: Type.String({ minLength: 1, maxLength: 8000 }) });

/** The reviewer's last word. */
export function verdictTool(onVerdict: (approved: boolean, comments: string) => void): AgentTool<typeof Verdict, undefined> {
  return {
    executionMode: "sequential",
    name: "review_verdict", label: "review_verdict", parameters: Verdict,
    description: "Give your verdict and finish: approved true only if the branch can be merged as is; comments must be specific.",
    execute: async (_id, p) => {
      onVerdict(p.approved, p.comments);
      return text("Verdict recorded. You are done.", true);
    },
  };
}
