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
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle(sqlite, { schema });
  // Table rebuilds (SQLite's only way to change a CHECK) must not cascade-delete children,
  // and PRAGMA foreign_keys is ignored inside the migrator's transaction, so toggle it here.
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // Only tables that migrations rebuild are checked: older stray rows elsewhere must not brick startup.
  const rebuilt = new Set(["channels", "channel_members", "messages", "reactions"]);
  const violations = (sqlite.query("PRAGMA foreign_key_check").all() as { table: string }[]).filter((v) => rebuilt.has(v.table));
  if (violations.length > 0) throw new Error(`Migration left ${violations.length} foreign key violations in chat tables`);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return { db, sqlite, close: () => sqlite.close() };
}

export { schema };
