import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const projectRoot = process.env.HIVE_PROJECT_ROOT || resolve(import.meta.dir,'..');
export const dataDir = process.env.HIVE_DATA_DIR || join(projectRoot, '.hive-data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new Database(join(dataDir, 'hive.sqlite'), { create: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]', workspace_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channels (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group','agent_dm')),
 title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_members (
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL, PRIMARY KEY(channel_id,member_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(channel_id,created_at,id);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, github_repo TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('backlog','todo','in_progress','in_review','blocked','done')),
 assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 pr_url TEXT
);
CREATE TABLE IF NOT EXISTS task_handoffs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, summary TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ended_at TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cost REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activities (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 type TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS activities_run ON activities(run_id,created_at);
CREATE TABLE IF NOT EXISTS sessions (
 agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 path TEXT NOT NULL, PRIMARY KEY(agent_id,channel_id)
);
`);
db.exec("UPDATE messages SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at) WHERE created_at NOT LIKE '%T%'");
if(!db.query("PRAGMA table_info(tasks)").all().some((column:any)=>column.name==='pr_url'))db.exec('ALTER TABLE tasks ADD COLUMN pr_url TEXT');
if(!db.query("PRAGMA table_info(workspaces)").all().some((column:any)=>column.name==='github_repo'))db.exec('ALTER TABLE workspaces ADD COLUMN github_repo TEXT');

export const id = () => crypto.randomUUID();
export const all = <T>(sql: string, ...args: any[]) => db.query(sql).all(...args) as T[];
export const one = <T>(sql: string, ...args: any[]) => db.query(sql).get(...args) as T | null;
export const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
