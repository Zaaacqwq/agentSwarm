import { openDatabase, type DbHandle } from "../src/db/client.ts";

export function memoryDb(): DbHandle {
  return openDatabase(":memory:");
}

export const ADMIN = { username: "admin", password: "correct horse battery" } as const;
