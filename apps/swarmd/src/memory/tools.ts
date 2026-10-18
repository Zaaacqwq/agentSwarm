import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { clipToSchema } from "../agents/clip.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

const Recall = Type.Object({ query: Type.String({ minLength: 2, maxLength: 300, description: "Words about what you want to know, e.g. 'SwiftUI build sandbox' or '登录 自动 fetch'" }) });

/** Search the team's lessons (R8): the team's, this project's and this role's. */
export function recallTool(search: (query: string) => string): AgentTool<typeof Recall, undefined> {
  return {
    name: "recall", label: "recall", parameters: Recall,
    description: "Search the team's lessons from earlier work (how things are done here, pitfalls met before). Lessons from agents are advice; check them against what you see.",
    prepareArguments: clipToSchema(Recall),
    execute: async (_id, p) => text(search(p.query)),
  };
}

const Lesson = Type.Object({
  title: Type.String({ minLength: 5, maxLength: 160, description: "One line someone would search for, e.g. 'SwiftUI projects: build with sim_build, not plain swiftc'" }),
  text: Type.String({ minLength: 10, maxLength: 1000, description: "What to do (or avoid) and why, so a future agent can act on it" }),
  scope: Type.Union([Type.Literal("team"), Type.Literal("project"), Type.Literal("role")], { description: "team: true anywhere; project: only this project; role: for one kind of agent" }),
  role: Type.Optional(Type.Union([Type.Literal("lead"), Type.Literal("researcher"), Type.Literal("architect"), Type.Literal("developer"), Type.Literal("reviewer"), Type.Literal("qa"), Type.Literal("marketer")])),
});

/** At a retrospective: keep what would have saved time (R8). */
export function recordLessonTool(record: (input: { title: string; text: string; scope: "team" | "project" | "role"; role?: string }) => string): AgentTool<typeof Lesson, undefined> {
  return {
    name: "record_lesson", label: "record_lesson", parameters: Lesson,
    description: "Keep a lesson for future work: a reusable way of doing something or a pitfall, not a log of this ticket. At most 3 per ticket; a lesson that says the same as an existing one improves it instead.",
    prepareArguments: clipToSchema(Lesson),
    execute: async (_id, p) => text(record(p)),
  };
}

const Proposal = Type.Object({
  role: Type.Union([Type.Literal("lead"), Type.Literal("researcher"), Type.Literal("architect"), Type.Literal("developer"), Type.Literal("reviewer"), Type.Literal("qa"), Type.Literal("marketer")]),
  change: Type.String({ minLength: 10, maxLength: 1500, description: "The line(s) to add to that role's handbook, written as an instruction" }),
  why: Type.String({ minLength: 10, maxLength: 800, description: "What happened in this ticket that shows it is needed" }),
});

/** At a retrospective: suggest a change to a role's handbook; the person decides (R8). */
export function proposeHandbookTool(propose: (input: { role: string; change: string; why: string }) => string): AgentTool<typeof Proposal, undefined> {
  return {
    name: "propose_handbook_change", label: "propose_handbook_change", parameters: Proposal,
    description: "Suggest a change to how a role works (its handbook) when this ticket showed it is needed. The person accepts or rejects it; nothing changes until then. At most 2 per ticket.",
    prepareArguments: clipToSchema(Proposal),
    execute: async (_id, p) => text(propose(p)),
  };
}
