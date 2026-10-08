import { Type, type Static } from "typebox";

export const EndpointKind = Type.Union([Type.Literal("openrouter"), Type.Literal("openai-compatible")]);
export type EndpointKind = Static<typeof EndpointKind>;

// API keys go in, never come out: responses only say whether one is stored.
export const Endpoint = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: EndpointKind,
  baseUrl: Type.String(),
  hasApiKey: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Endpoint = Static<typeof Endpoint>;

const ApiKey = Type.String({ minLength: 8, maxLength: 512, pattern: "^[\\x21-\\x7e]+$" });
const BaseUrl = Type.String({ minLength: 8, maxLength: 512, pattern: "^https?://" });

export const CreateEndpoint = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    kind: EndpointKind,
    baseUrl: Type.Optional(BaseUrl),
    apiKey: ApiKey,
  },
  { additionalProperties: false },
);
export type CreateEndpoint = Static<typeof CreateEndpoint>;

export const UpdateEndpoint = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    baseUrl: Type.Optional(BaseUrl),
    apiKey: Type.Optional(ApiKey),
  },
  { additionalProperties: false },
);
export type UpdateEndpoint = Static<typeof UpdateEndpoint>;
