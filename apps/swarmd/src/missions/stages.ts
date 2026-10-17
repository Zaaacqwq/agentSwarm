import type { MissionStage } from "../db/schema.ts";

/**
 * The mission pipeline (PLAN.md section 4, R3):
 *   intake → research → discussion → planning → [you approve] → building → verifying → [you merge] → retro → done
 * The fast track skips research and discussion. Only the two gates need a person, and no agent can
 * move a mission through either of them.
 */
export type Actor = "lead" | "person" | "github" | "system";

/** Stages in which the lead works. */
export const WORKING: ReadonlySet<MissionStage> = new Set(["intake", "research", "discussion", "planning", "building", "verifying", "retro"]);
export const GATES: ReadonlySet<MissionStage> = new Set(["awaiting_approval", "awaiting_merge"]);
export const ENDED: ReadonlySet<MissionStage> = new Set(["done", "cancelled"]);

/** Where stage_done leads; null where the stage does not end with stage_done. */
export function afterStageDone(stage: MissionStage, fast: boolean): MissionStage | null {
  switch (stage) {
    case "intake": return fast ? "planning" : "research";
    case "research": return "discussion";
    case "discussion": return "planning";
    case "building": return "verifying";
    case "verifying": return "awaiting_merge";
    case "retro": return "done";
    default: return null;
  }
}

const ALLOWED: Record<Actor, readonly (readonly [MissionStage | "*", MissionStage])[]> = {
  lead: [
    ["intake", "research"], ["intake", "planning"], ["research", "discussion"], ["discussion", "planning"],
    ["planning", "awaiting_approval"], ["building", "verifying"], ["verifying", "awaiting_merge"], ["retro", "done"],
  ],
  person: [["awaiting_approval", "building"], ["awaiting_approval", "planning"], ["*", "cancelled"]],
  github: [["verifying", "retro"], ["awaiting_merge", "retro"], ["*", "cancelled"]],
  system: [["*", "cancelled"]],
};

export function canMove(from: MissionStage, to: MissionStage, by: Actor, fast = false): boolean {
  if (ENDED.has(from)) return false;
  if (by === "lead" && from === "intake") return to === afterStageDone("intake", fast);
  return ALLOWED[by].some(([f, t]) => (f === from || f === "*") && t === to);
}

/** The documents a stage must have pushed before it can end, relative to the mission's docs path. */
export function requiredDocs(stage: MissionStage): string[] {
  switch (stage) {
    case "research": return ["research.md"];
    case "discussion": return ["decisions.md"];
    case "planning": return ["plan.md"];
    case "verifying": return ["acceptance.md"];
    default: return [];
  }
}

export const DOC_NAMES = ["research.md", "decisions.md", "plan.md", "acceptance.md"] as const;

/** Which tools the lead has in each stage. */
export interface StageTools {
  /** "read": look and run commands only; "all": also write, commit and push. */
  readonly workstation: "read" | "all";
  /** spawn_agent, wait_agents, review_agent, merge_agent, ... */
  readonly tree: boolean;
  readonly web: boolean;
  readonly pullRequest: boolean;
  readonly stageDone: boolean;
  readonly requestApproval: boolean;
}

export function stageTools(stage: MissionStage): StageTools {
  const base = { workstation: "all", tree: false, web: false, pullRequest: false, stageDone: true, requestApproval: false } as const;
  switch (stage) {
    case "intake": return { ...base, workstation: "read" };
    case "research": return { ...base, tree: true, web: true };
    case "discussion": return base;
    case "planning":
    case "awaiting_approval": return { ...base, tree: true, stageDone: false, requestApproval: true };
    case "building": return { ...base, tree: true };
    case "verifying": return { ...base, tree: true, pullRequest: true };
    // Follow-ups on an open pull request: fix and push, but the stage only ends on GitHub.
    case "awaiting_merge": return { ...base, tree: true, pullRequest: true, stageDone: false };
    case "retro": return { ...base, workstation: "read" };
    default: return { ...base, workstation: "read", stageDone: false };
  }
}

export const STAGE_LABEL: Record<MissionStage, string> = {
  intake: "Intake", research: "Research", discussion: "Discussion", planning: "Planning", awaiting_approval: "Waiting for your approval",
  building: "Building", verifying: "Verifying", awaiting_merge: "Waiting for you to merge", retro: "Retrospective", done: "Done", cancelled: "Cancelled",
};
