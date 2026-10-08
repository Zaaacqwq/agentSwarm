import { Type, type Static } from "typebox";

export const Credentials = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" }),
    password: Type.String({ minLength: 12, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export type Credentials = Static<typeof Credentials>;

export const SessionInfo = Type.Object({
  setupRequired: Type.Boolean(),
  user: Type.Union([
    Type.Null(),
    Type.Object({ id: Type.String(), username: Type.String(), role: Type.Union([Type.Literal("admin"), Type.Literal("member")]) }),
  ]),
});
export type SessionInfo = Static<typeof SessionInfo>;
