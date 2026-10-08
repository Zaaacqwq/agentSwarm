import { Type, type Static } from "typebox";

export const RunStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
]);
export type RunStatus = Static<typeof RunStatus>;

export const Run = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  status: RunStatus,
  error: Type.Union([Type.String(), Type.Null()]),
  triggerMessageIds: Type.Array(Type.Number()),
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Number(),
  cacheWriteTokens: Type.Number(),
  costUsd: Type.Number(),
  createdAt: Type.Number(),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
});
export type Run = Static<typeof Run>;

export const ActivityKind = Type.Union([
  Type.Literal("assistant_text"),
  Type.Literal("thinking"),
  Type.Literal("tool_call"),
  Type.Literal("tool_result"),
  Type.Literal("error"),
  Type.Literal("notice"),
]);
export type ActivityKind = Static<typeof ActivityKind>;

export const ActivityEvent = Type.Object({
  id: Type.Number(),
  runId: Type.String(),
  agentId: Type.String(),
  kind: ActivityKind,
  payload: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.Number(),
});
export type ActivityEvent = Static<typeof ActivityEvent>;

export const UsageSummary = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  costUsd: Type.Number(),
  runs: Type.Number(),
});
export type UsageSummary = Static<typeof UsageSummary>;
