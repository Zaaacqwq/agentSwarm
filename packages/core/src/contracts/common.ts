import { Type, type Static } from "typebox";

export const ErrorBody = Type.Object({
  error: Type.String(),
  message: Type.String(),
});
export type ErrorBody = Static<typeof ErrorBody>;

export const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export type IdParams = Static<typeof IdParams>;

export const Ok = Type.Object({ ok: Type.Literal(true) });
