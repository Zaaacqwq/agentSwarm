import type { MissionKind, MissionStage } from "../db/schema.ts";

/**
 * The mission pipeline (PLAN.md section 4, R3; kinds since R5):
 *   feature:    intake → research → discussion → planning → [you approve] → building → verifying → [you merge] → retro → done
 *               (fast: intake → planning → …)
 *   bug:        intake → planning (reproduce first) → [you approve] → building → verifying → [you merge] → retro → done
 *   research:   intake → research → discussion → done          (no code changes, no gates)
 *   experiment: intake → building → done                        (local sandbox only: nothing reaches GitHub)
 * Only a person passes the gates; no agent can move a mission through them.
 */
export type Actor = "lead" | "person" | "github" | "system";

/** Which flow a mission follows. A bare boolean means a feature, fast or not (R3 callers). */
export interface Flow {
  readonly kind: MissionKind;
  readonly fast: boolean;
}

export const flowOf = (f: Flow | boolean): Flow => (typeof f === "boolean" ? { kind: "feature", fast: f } : f);

/** The working stages a flow goes through, in order (for checklists). */
export function stagesOf(f: Flow | boolean): MissionStage[] {
  const { kind, fast } = flowOf(f);
  switch (kind) {
    case "research": return ["intake", "research", "discussion", "done"];
    case "experiment": return ["intake", "building", "done"];
    case "bug": return ["intake", "planning", "awaiting_approval", "building", "verifying", "awaiting_merge", "retro", "done"];
    default: return ["intake", ...(fast ? [] : ["research", "discussion"] as MissionStage[]), "planning", "awaiting_approval", "building", "verifying", "awaiting_merge", "retro", "done"];
  }
}

/** Stages in which the lead works. */
export const WORKING: ReadonlySet<MissionStage> = new Set(["intake", "research", "discussion", "planning", "building", "verifying", "retro"]);
export const GATES: ReadonlySet<MissionStage> = new Set(["awaiting_approval", "awaiting_merge"]);
export const ENDED: ReadonlySet<MissionStage> = new Set(["done", "cancelled"]);

/** Where stage_done leads; null where the stage does not end with stage_done. */
export function afterStageDone(stage: MissionStage, flow: Flow | boolean): MissionStage | null {
  const { kind, fast } = flowOf(flow);
  switch (stage) {
    case "intake":
      if (kind === "experiment") return "building";
      if (kind === "research") return "research";
      return kind === "bug" || fast ? "planning" : "research";
    case "research": return "discussion";
    case "discussion": return kind === "research" ? "done" : "planning";
    case "building": return kind === "experiment" ? "done" : "verifying";
    case "verifying": return kind === "experiment" || kind === "research" ? null : "awaiting_merge";
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

export function canMove(from: MissionStage, to: MissionStage, by: Actor, flow: Flow | boolean = false): boolean {
  if (ENDED.has(from)) return false;
  const f = flowOf(flow);
  if (by === "lead") {
    // The lead only ever moves a mission one step along its own flow.
    if (from === "planning" && to === "awaiting_approval") return f.kind === "feature" || f.kind === "bug";
    return afterStageDone(from, f) === to && (from === "intake" || ALLOWED.lead.some(([a, b]) => a === from && b === to) || KIND_STEPS.some(([k, a, b]) => k === f.kind && a === from && b === to));
  }
  return ALLOWED[by].some(([a, b]) => (a === from || a === "*") && b === to);
}

/** Lead steps that only some kinds have. */
const KIND_STEPS: readonly (readonly [MissionKind, MissionStage, MissionStage])[] = [
  ["research", "discussion", "done"],
  ["experiment", "building", "done"],
];

/** The documents a stage must have pushed before it can end, relative to the mission's docs path. */
export function requiredDocs(stage: MissionStage, kind: MissionKind = "feature"): string[] {
  switch (stage) {
    case "research": return ["research.md"];
    case "discussion": return ["decisions.md"];
    case "planning": return ["plan.md"];
    case "building": return kind === "experiment" ? ["results.md"] : [];
    case "verifying": return ["acceptance.md"];
    default: return [];
  }
}

export const DOC_NAMES = ["research.md", "decisions.md", "plan.md", "acceptance.md", "results.md"] as const;

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
