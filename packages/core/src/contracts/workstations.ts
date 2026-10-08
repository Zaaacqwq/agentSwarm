import { Type, type Static } from "typebox";

export const WorkstationKind = Type.Union([Type.Literal("macos-user"), Type.Literal("local-fake")]);

export const LeaseInfo = Type.Object({
  kind: Type.Literal("workstation-write"),
  resourceId: Type.String(),
  holderAgentId: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  acquiredAt: Type.Number(),
  expiresAt: Type.Number(),
});
export type LeaseInfo = Static<typeof LeaseInfo>;

export const Workstation = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: WorkstationKind,
  osUser: Type.String(),
  networkAllowed: Type.Boolean(),
  agentIds: Type.Array(Type.String()),
  writeLease: Type.Union([LeaseInfo, Type.Null()]),
  createdAt: Type.Number(),
});
export type Workstation = Static<typeof Workstation>;

export const CreateWorkstation = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 40 }),
    osUser: Type.String({ pattern: "^ws-[0-9]{1,3}$" }),
  },
  { additionalProperties: false },
);
export type CreateWorkstation = Static<typeof CreateWorkstation>;

export const BindWorkstation = Type.Object(
  { workstationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) },
  { additionalProperties: false },
);

export const Repository = Type.Object({
  id: Type.String(),
  name: Type.String(),
  githubFullName: Type.String(),
  defaultBranch: Type.String(),
  createdAt: Type.Number(),
});
export type Repository = Static<typeof Repository>;

export const CreateRepository = Type.Object(
  {
    githubFullName: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 140 }),
    defaultBranch: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._/-]{1,100}$" })),
  },
  { additionalProperties: false },
);
export type CreateRepository = Static<typeof CreateRepository>;

export const Worktree = Type.Object({
  id: Type.String(),
  workstationId: Type.String(),
  repositoryId: Type.String(),
  agentId: Type.String(),
  scope: Type.String(),
  branch: Type.String(),
  createdAt: Type.Number(),
  lastUsedAt: Type.Number(),
});
export type Worktree = Static<typeof Worktree>;

export const Terminal = Type.Object({ name: Type.String(), createdAt: Type.Number(), command: Type.String() });
export type Terminal = Static<typeof Terminal>;

export const GitPush = Type.Object({
  id: Type.Number(),
  worktreeId: Type.String(),
  agentId: Type.String(),
  branch: Type.String(),
  headSha: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal("rejected"), Type.Literal("pushed"), Type.Literal("failed")]),
  reason: Type.Union([Type.String(), Type.Null()]),
  prUrl: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
});
export type GitPush = Static<typeof GitPush>;

export const PressureLevel = Type.Union([Type.Literal("normal"), Type.Literal("warn"), Type.Literal("critical"), Type.Literal("unknown")]);
export type PressureLevel = Static<typeof PressureLevel>;

export const HostStatus = Type.Object({
  pressure: PressureLevel,
  swapUsedMb: Type.Number(),
  disks: Type.Array(Type.Object({ mount: Type.String(), freeGb: Type.Number(), totalGb: Type.Number() })),
  heavyTasks: Type.Object({ running: Type.Number(), waiting: Type.Number(), slots: Type.Number() }),
  workstationsReady: Type.Boolean(),
  workstationsReason: Type.Optional(Type.String()),
  sampledAt: Type.Number(),
});
export type HostStatus = Static<typeof HostStatus>;
