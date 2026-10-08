import { Type, type Static } from "typebox";

export const ThinkingLevel = Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const AgentState = Type.Union([Type.Literal("idle"), Type.Literal("queued"), Type.Literal("working"), Type.Literal("error")]);
export type AgentState = Static<typeof AgentState>;

export const ToolGrant = Type.Object({
  toolpackId: Type.String({ minLength: 1, maxLength: 64 }),
  // "*" means every tool in the pack.
  toolName: Type.String({ minLength: 1, maxLength: 64 }),
});
export type ToolGrant = Static<typeof ToolGrant>;

export const Agent = Type.Object({
  id: Type.String(),
  name: Type.String(),
  role: Type.String(),
  instructions: Type.String(),
  endpointId: Type.Union([Type.String(), Type.Null()]),
  modelId: Type.String(),
  thinkingLevel: ThinkingLevel,
  avatarSeed: Type.String(),
  grants: Type.Array(ToolGrant),
  workstationId: Type.Union([Type.String(), Type.Null()]),
  state: AgentState,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Agent = Static<typeof Agent>;

const AgentName = Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]*$" });

export const CreateAgent = Type.Object(
  {
    name: AgentName,
    role: Type.String({ maxLength: 200 }),
    instructions: Type.String({ maxLength: 20000 }),
    endpointId: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    thinkingLevel: ThinkingLevel,
    grants: Type.Optional(Type.Array(ToolGrant, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export type CreateAgent = Static<typeof CreateAgent>;

export const UpdateAgent = Type.Partial(CreateAgent, { additionalProperties: false });
export type UpdateAgent = Static<typeof UpdateAgent>;

export const ToolpackInfo = Type.Object({
  id: Type.String(),
  label: Type.String(),
  available: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  tools: Type.Array(Type.Object({ name: Type.String(), label: Type.String(), access: Type.String(), description: Type.String() })),
});
export type ToolpackInfo = Static<typeof ToolpackInfo>;
