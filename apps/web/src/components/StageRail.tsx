import type { MissionStage } from "@agentswarm/contracts";

/** The pipeline in order; gates are where a person decides. */
const STEPS: { stage: MissionStage; label: string; gate?: boolean }[] = [
  { stage: "intake", label: "Intake" },
  { stage: "research", label: "Research" },
  { stage: "discussion", label: "Discussion" },
  { stage: "planning", label: "Plan" },
  { stage: "awaiting_approval", label: "You approve", gate: true },
  { stage: "building", label: "Build" },
  { stage: "verifying", label: "Verify" },
  { stage: "awaiting_merge", label: "You merge", gate: true },
  { stage: "retro", label: "Retro" },
  { stage: "done", label: "Done" },
];

export const STAGE_LABEL: Record<MissionStage, string> = {
  intake: "Intake", research: "Research", discussion: "Discussion", planning: "Planning", awaiting_approval: "Waiting for your approval",
  building: "Building", verifying: "Verifying", awaiting_merge: "Waiting for you to merge", review: "Waiting for your decision", retro: "Retrospective", done: "Done", cancelled: "Cancelled",
};

/** Where the mission is: steps behind it are inked, the current one carries the signal colour. */
export function StageRail({ stage, fast, compact = false }: { stage: MissionStage; fast: boolean; compact?: boolean }) {
  const at = STEPS.findIndex((s) => s.stage === stage);
  return (
    <ol className={`rail${compact ? " compact" : ""}${stage === "cancelled" ? " stopped" : ""}`} aria-label={`Stage: ${STAGE_LABEL[stage]}`}>
      {STEPS.map((s, i) => {
        const skipped = fast && (s.stage === "research" || s.stage === "discussion");
        const state = skipped ? "skipped" : stage === "done" || i < at ? "past" : i === at ? "now" : "next";
        return (
          <li key={s.stage} className={`step ${state}${s.gate ? " gate" : ""}`} aria-current={state === "now" ? "step" : undefined} title={s.label}>
            <span className="dot" aria-hidden="true" />
            {!compact && <span className="label">{s.label}</span>}
          </li>
        );
      })}
    </ol>
  );
}
