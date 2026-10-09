import { Type, type Static } from "typebox";

export const ApprovalKind = Type.Union([Type.Literal("question"), Type.Literal("desktop"), Type.Literal("browser_site")]);
export type ApprovalKind = Static<typeof ApprovalKind>;

export const ApprovalStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"),
  Type.Literal("expired"), Type.Literal("cancelled"), Type.Literal("revoked"),
]);
export type ApprovalStatus = Static<typeof ApprovalStatus>;

const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Number>>(t: T) => Type.Union([t, Type.Null()]);

export const Approval = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  agentName: Type.String(),
  runId: Nullable(Type.String()),
  channelId: Nullable(Type.String()),
  messageId: Nullable(Type.Number()),
  kind: ApprovalKind,
  scope: Type.String(),
  question: Type.String(),
  options: Type.Array(Type.String()),
  status: ApprovalStatus,
  answer: Nullable(Type.String()),
  durationMs: Nullable(Type.Number()),
  decidedBy: Nullable(Type.String()),
  decidedAt: Nullable(Type.Number()),
  timeoutAt: Type.Number(),
  expiresAt: Nullable(Type.Number()),
  createdAt: Type.Number(),
});
export type Approval = Static<typeof Approval>;

export const DecideApproval = Type.Object(
  {
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
    /** The chosen option or a free-text reply (ask_human). */
    answer: Type.Optional(Type.String({ maxLength: 2000 })),
    /** Session length a person grants, overriding what the agent asked for. */
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  },
  { additionalProperties: false },
);
export type DecideApproval = Static<typeof DecideApproval>;

export const ApprovalQuery = Type.Object({
  status: Type.Optional(Type.Union([ApprovalStatus, Type.Literal("active")])),
  channelId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
});
export type ApprovalQuery = Static<typeof ApprovalQuery>;

export const DesktopDisplay = Type.Object({
  index: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  imageWidth: Type.Number(),
  imageHeight: Type.Number(),
  main: Type.Boolean(),
});

export const DesktopStatus = Type.Object({
  /** The helper is installed and answering. */
  available: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  screenRecording: Type.Boolean(),
  accessibility: Type.Boolean(),
  displays: Type.Array(DesktopDisplay),
  holder: Type.Union([
    Type.Object({ agentId: Type.String(), agentName: Type.String(), approvalId: Type.String(), until: Type.Number() }),
    Type.Null(),
  ]),
});
export type DesktopStatus = Static<typeof DesktopStatus>;

export const Screenshot = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  runId: Nullable(Type.String()),
  source: Type.Union([Type.Literal("browser"), Type.Literal("desktop")]),
  width: Type.Number(),
  height: Type.Number(),
  size: Type.Number(),
  createdAt: Type.Number(),
});
export type Screenshot = Static<typeof Screenshot>;

export const BrowserProfile = Type.Object({
  exists: Type.Boolean(),
  workstationId: Nullable(Type.String()),
  lastUsedAt: Nullable(Type.Number()),
  siteApprovals: Type.Array(Approval),
});
export type BrowserProfile = Static<typeof BrowserProfile>;
