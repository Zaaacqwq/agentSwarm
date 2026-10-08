import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import * as schema from "@hive/core/db";

export type Db = BunSQLiteDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Db;
  readonly sqlite: Database;
  close(): void;
}

const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

/** Opens (or creates) the database, enables WAL and foreign keys, and applies pending migrations. */
export function openDatabase(path: string): DbHandle {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite, close: () => sqlite.close() };
}

export { schema };
