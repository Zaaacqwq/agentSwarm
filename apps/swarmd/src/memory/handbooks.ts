import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { HandbookProposalView, HandbookView, Role } from "@agentswarm/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { clean, SECRET } from "./search.ts";

export const MAX_HANDBOOK = 4000;
const MAX_OPEN_PROPOSALS = 30;

/** A handbook with a proposed change appended, one instruction per line: exactly what "accept as proposed" saves. */
export function withChange(handbook: string, change: string): string {
  return `${handbook}\n${clean(change).split("\n").filter((l) => l.trim()).map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}`;
}

/** How each role works, as agentSwarm starts out. You change them on the dashboard; agents only propose. */
export const DEFAULT_HANDBOOKS: Record<Role, string> = {
  lead: [
    "- Read the project's profile and the lessons you are given before you plan: they are what earlier work learned.",
    "- Split work into packages that touch different files, so sub-agents can work in parallel and merge cleanly. Do small things yourself.",
    "- Every brief is complete: the goal, the files, the acceptance criteria, how to test. A sub-agent sees nothing else.",
    "- Ask the person little, and clearly: numbered questions, each with your recommendation.",
    "- Never merge work no reviewer approved; never say tests pass without having seen them pass.",
    "- When something fails twice the same way, stop and change the approach, or ask.",
  ].join("\n"),
  researcher: [
    "- Answer the one question you were given. Prefer primary sources: official docs, repositories, changelogs.",
    "- Give every finding its link and, where it matters, its date: things change fast.",
    "- Separate facts from opinions. Say what you could not find.",
    "- Prefer existing, maintained solutions to building from scratch; note licence and activity.",
    "- Report in short sections: findings with links, options compared, your recommendation.",
  ].join("\n"),
  architect: [
    "- Design the smallest thing that meets the goal; follow how the repository already does things.",
    "- Name the files and modules, what each does, and the interfaces between them.",
    "- Make every package testable on its own, with concrete acceptance criteria.",
    "- List the risks and what you would check first.",
  ].join("\n"),
  developer: [
    "- Read the code around the change first; follow its style, naming and structure.",
    "- Make the smallest change that does the job; leave unrelated files alone.",
    "- For a bug: a failing test first, then the fix. Run the tests and quote what they printed.",
    "- Commit in small steps with clear messages. Never commit secrets or the project's local files.",
    "- iOS: build with xcodebuild (the wrapper handles the sandbox), or sim_build if you have a simulator. Web: run the dev server on the project's port.",
  ].join("\n"),
  reviewer: [
    "- Check the change against what was asked and its acceptance criteria, not against your taste.",
    "- Run the tests. Look for missing tests, edge cases, error handling, secrets, and changes outside the scope.",
    "- Be specific: file, line, what is wrong, what to do. Approve only what can be merged as is.",
  ].join("\n"),
  qa: [
    "- Check each acceptance criterion literally, one by one, and give evidence for each: command output or a screenshot.",
    "- Try the empty, wrong and slow cases too: no data, bad input, no network.",
    "- Do not fix code. For a failure, write the steps to reproduce it and what you expected.",
    "- On screen: read the screen (sim_ui, browser_snapshot) before tapping; look again after every tap.",
  ].join("\n"),
  marketer: [
    "- Claim only what the product really does; check every claim against the code, its documents or a screenshot.",
    "- Write for the audience: what it does for them, in their words, not how it is built.",
    "- No invented numbers, reviews, awards or quotes.",
    "- Respect the limits of each place (App Store name 30 characters, subtitle 30, keywords 100).",
    "- Match the language of the product's users (the person tells you, or the product's own text does).",
  ].join("\n"),
};

/** The handbook an agent follows: its role, from what it was spawned as (a mission's root is always the lead). */
export function roleOf(role: string, isMissionLead: boolean): Role {
  if (isMissionLead) return "lead";
  const r = role.toLowerCase();
  if (/\bmarket|\bcopywrit|\bwriter\b/.test(r)) return "marketer";
  if (/\breview/.test(r)) return "reviewer";
  if (/\bqa\b|\btest(er|ing)?\b|\bverif/.test(r)) return "qa";
  if (/\bresearch/.test(r)) return "researcher";
  if (/\barchitect/.test(r)) return "architect";
  if (/^(team )?lead(er)?$/.test(r.trim())) return "lead";
  return "developer";
}

/** Each role's handbook, its versions, and the changes agents propose at retrospectives (R8). */
export class HandbookService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  text(role: Role): string {
    return this.db.select().from(schema.handbooks).where(eq(schema.handbooks.role, role)).get()?.text ?? DEFAULT_HANDBOOKS[role];
  }

  view(role: Role): HandbookView {
    const row = this.db.select().from(schema.handbooks).where(eq(schema.handbooks.role, role)).get();
    const versions = this.db.select().from(schema.handbookVersions).where(eq(schema.handbookVersions.role, role)).orderBy(desc(schema.handbookVersions.id)).all()
      .map((v) => ({ id: v.id, author: v.author, createdAt: v.createdAt }));
    return { role, text: row?.text ?? DEFAULT_HANDBOOKS[role], updatedBy: row?.updatedBy ?? "agentSwarm", updatedAt: row?.updatedAt ?? null, isDefault: !row, versions };
  }

  /** A new text for a role's handbook; the old one is kept as a version. */
  set(actor: string, role: Role, text: string, now = Date.now()): HandbookView {
    const clean = text.trim();
    if (!clean || clean.length > MAX_HANDBOOK) throw badRequest(`A handbook is 1 to ${MAX_HANDBOOK} characters`);
    if (SECRET.test(clean)) throw badRequest("That looks like a credential: handbooks never hold secrets");
    this.db.insert(schema.handbookVersions).values({ role, text: this.text(role), author: this.view(role).updatedBy, createdAt: now }).run();
    const values = { text: clean, updatedBy: actor, updatedAt: now };
    this.db.insert(schema.handbooks).values({ role, ...values }).onConflictDoUpdate({ target: schema.handbooks.role, set: values }).run();
    audit(this.db, actor, "handbook.set", role, { length: clean.length }, now);
    return this.view(role);
  }

  restore(actor: string, role: Role, versionId: number, now = Date.now()): HandbookView {
    const v = this.db.select().from(schema.handbookVersions).where(and(eq(schema.handbookVersions.role, role), eq(schema.handbookVersions.id, versionId))).get();
    if (!v) throw notFound("No such version");
    return this.set(actor, role, v.text, now);
  }

  versionText(role: Role, versionId: number): string {
    const v = this.db.select().from(schema.handbookVersions).where(and(eq(schema.handbookVersions.role, role), eq(schema.handbookVersions.id, versionId))).get();
    if (!v) throw notFound("No such version");
    return v.text;
  }

  proposals(status?: "open" | "accepted" | "rejected"): HandbookProposalView[] {
    const rows = status
      ? this.db.select().from(schema.handbookProposals).where(eq(schema.handbookProposals.status, status)).orderBy(desc(schema.handbookProposals.createdAt)).all()
      : this.db.select().from(schema.handbookProposals).orderBy(desc(schema.handbookProposals.createdAt)).all();
    return rows.map((p) => ({ ...p }));
  }

  /** An agent's suggestion: it waits for you, and changes nothing until you accept it. */
  propose(author: string, source: string | null, role: Role, change: string, why: string, now = Date.now()): HandbookProposalView {
    const c = clean(change).slice(0, 1500);
    const w = clean(why, true).slice(0, 800);
    if (SECRET.test(`${c}\n${w}`)) throw badRequest("That looks like a credential");
    if (this.proposals("open").length >= MAX_OPEN_PROPOSALS) throw conflict("Many handbook changes already wait for the person; mention this one in your retrospective instead");
    const row = { id: `hbp_${randomBytes(12).toString("hex")}`, role, change: c, why: w, author: clean(author, true), source, status: "open" as const, createdAt: now, decidedAt: null };
    this.db.insert(schema.handbookProposals).values(row).run();
    return { ...row };
  }

  /** Accept (as proposed: appended; or as you edited the whole handbook) or reject. */
  decide(actor: string, id: string, accept: boolean, text?: string, now = Date.now()): HandbookProposalView {
    const p = this.db.select().from(schema.handbookProposals).where(eq(schema.handbookProposals.id, id)).get();
    if (!p) throw notFound("No such proposal");
    if (p.status !== "open") throw conflict("That proposal was already decided");
    this.db.transaction(() => {
      if (accept) this.set(actor, p.role, text ?? withChange(this.text(p.role), p.change), now);
      this.db.update(schema.handbookProposals).set({ status: accept ? "accepted" : "rejected", decidedAt: now }).where(eq(schema.handbookProposals.id, id)).run();
    });
    audit(this.db, actor, accept ? "handbook.accept" : "handbook.reject", id, { role: p.role }, now);
    return { ...this.db.select().from(schema.handbookProposals).where(eq(schema.handbookProposals.id, id)).get()! };
  }
}
