import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  readonly db: Db;
  readonly sqlite: Database.Database;
  close(): void;
}

const MIGRATIONS = resolve(import.meta.dirname, "../../drizzle");

/** Opens (creating if needed) and migrates. A database with pending migrations is backed up first. */
export function openDatabase(path: string, now = Date.now()): DbHandle {
  const existed = path !== ":memory:" && existsSync(path);
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  if (existed && pendingMigrations(sqlite) > 0) {
    const backup = `${path}.backup-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    sqlite.prepare("VACUUM INTO ?").run(backup);
  }
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, sqlite, close: () => sqlite.close() };
}

function pendingMigrations(sqlite: Database.Database): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: unknown[] };
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  if (!table) return journal.entries.length;
  const applied = (sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
  return journal.entries.length - applied;
}

export { schema };
