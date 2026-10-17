import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { audit } from "../audit.ts";
import { badRequest } from "../errors.ts";

const ROW = "machine";

export interface MachineSettings {
  /** Local ports agents may not connect to (production services, databases on this Mac). */
  readonly denyPorts: readonly number[];
}

/**
 * Settings about this Mac that the workstations must follow. ws-exec reads the port list from
 * <mirrors>/.agentswarm/deny-ports.json: swarmd can write there, workstation users can only read it.
 */
export class MachineService {
  private readonly db: Db;
  private readonly mirrorsDir: string;
  /** Always denied, whatever the list says (swarmd's own webhook port). */
  private readonly always: readonly number[];

  constructor(db: Db, mirrorsDir: string, always: readonly number[] = []) {
    this.db = db;
    this.mirrorsDir = mirrorsDir;
    this.always = always;
  }

  get(): MachineSettings {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.id, ROW)).get();
    return { denyPorts: [], ...(row?.value as Partial<MachineSettings> | undefined) };
  }

  set(actor: string, input: MachineSettings, now = Date.now()): MachineSettings {
    const ports = [...new Set(input.denyPorts)].sort((a, b) => a - b);
    if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw badRequest("Ports are whole numbers from 1 to 65535");
    if (ports.length > 200) throw badRequest("At most 200 ports");
    const values = { value: { denyPorts: ports } as Record<string, unknown>, secretSealed: null, updatedAt: now };
    this.db.insert(schema.settings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: schema.settings.id, set: values }).run();
    audit(this.db, actor, "machine.set", ROW, { denyPorts: ports }, now);
    this.write();
    return this.get();
  }

  /** Writes the file ws-exec reads (at startup too, so the file always matches the database). */
  write(): void {
    const dir = join(this.mirrorsDir, ".agentswarm");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const file = join(dir, "deny-ports.json");
    writeFileSync(`${file}.tmp`, JSON.stringify([...new Set([...this.always, ...this.get().denyPorts])]), { mode: 0o644 });
    chmodSync(`${file}.tmp`, 0o644);
    renameSync(`${file}.tmp`, file);
  }
}
