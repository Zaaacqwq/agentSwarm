import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/client.ts";

describe("migrations", () => {
  test("0002 rebuilds channels without losing messages or members", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hive-mig-")), "hive.db");
    // Build a P2-era database by applying only 0000 and 0001 by hand.
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA foreign_keys = ON;");
    for (const f of ["0000_init.sql", "0001_workstations.sql"]) {
      for (const stmt of readFileSync(join(import.meta.dir, "../drizzle", f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) raw.exec(stmt);
    }
    raw.exec(`
      insert into organizations values ('org_1','Default',1);
      insert into users values ('usr_1','org_1','admin','x','admin',1);
      insert into endpoints values ('ep_1','org_1','usr_1','OR','openrouter','https://x','v1:a:b',1,1);
      insert into agents values ('agt_1','org_1','usr_1','Ada','dev','', 'ep_1','m','off','seed',1,1);
      insert into channels values ('ch_1','org_1','usr_1','dm','usr_1:agt_1',1);
      insert into channel_members values ('ch_1','user','usr_1',1), ('ch_1','agent','agt_1',1);
      insert into messages (channel_id, author_kind, author_id, body, run_id, created_at) values ('ch_1','user','usr_1','hello cedar42',null,1), ('ch_1','agent','agt_1','hi back',null,2);
    `);
    // Record the first two migrations as applied, the way drizzle does.
    raw.exec("create table if not exists __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)");
    const journal = JSON.parse(readFileSync(join(import.meta.dir, "../drizzle/meta/_journal.json"), "utf8")) as { entries: { when: number; tag: string }[] };
    for (const e of journal.entries.slice(0, 2)) {
      const sqlText = readFileSync(join(import.meta.dir, "../drizzle", `${e.tag}.sql`), "utf8");
      const hash = new Bun.CryptoHasher("sha256").update(sqlText).digest("hex");
      raw.query("insert into __drizzle_migrations (hash, created_at) values (?, ?)").run(hash, e.when);
    }
    raw.close();

    const handle = openDatabase(path);
    const counts = handle.sqlite.query("select (select count(*) from messages) m, (select count(*) from channel_members) cm, (select count(*) from channels) c").get();
    expect(counts).toEqual({ m: 2, cm: 2, c: 1 });
    const names = handle.sqlite.query("select author_name from messages order by id").all();
    expect(names).toEqual([{ author_name: "admin" }, { author_name: "Ada" }]);
    const found = handle.sqlite.query("select rowid from messages_fts where messages_fts match ?").all('"cedar"');
    expect(found).toEqual([{ rowid: 1 }]);
    expect(handle.sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    handle.close();
  });
});
