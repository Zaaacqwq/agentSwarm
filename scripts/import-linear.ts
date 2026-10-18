// One-off (R7): moves what is still open in Linear onto the board before the Linear integration is removed.
// Run with swarmd stopped:  node scripts/import-linear.ts [--dry-run]
// - every open issue (not completed or canceled) becomes a Backlog ticket with its Linear id and link;
// - Fridgy and betterUWWorks issues go to their projects, Sandbox to the sandbox, Ideas to ideas; issues in no
//   project (Linear's onboarding samples) are skipped; a Bug label makes it a bug;
// - a ticket Linear handed to agentSwarm whose mission is still open (ZAA-6) is stopped first.
import { join } from "node:path";
import { openDatabase } from "../apps/swarmd/src/db/client.ts";
import { SecretBox } from "../apps/swarmd/src/crypto/secret-box.ts";
import { loadConfig } from "../apps/swarmd/src/config.ts";
import { createServices } from "../apps/swarmd/src/app/services.ts";
import { SudoBackend } from "../apps/swarmd/src/workstations/backend.ts";
import { GitHubRest } from "../apps/swarmd/src/github/github-client.ts";
import { createGitRunner } from "../apps/swarmd/src/github/git.ts";
import { PRODUCTION_LAYOUT } from "@agentswarm/ws-exec";
import { DiscordJsTransport } from "../apps/swarmd/src/discord/discord-js.ts";

const dry = process.argv.includes("--dry-run");
const config = loadConfig();
const db = openDatabase(join(config.dataDir, "agentswarm.db"));
const secrets = await SecretBox.fromKeyFile(join(config.dataDir, "master.key"));
const s = createServices({
  db: db.db, secrets, backend: new SudoBackend(), githubClient: new GitHubRest(),
  git: createGitRunner({ askpassDir: config.dataDir, inboxGlob: `${PRODUCTION_LAYOUT.inbox}/*` }), layout: PRODUCTION_LAYOUT,
  maxConcurrentRuns: 1, screensDir: join(config.dataDir, "screens"), attachmentsDir: join(config.dataDir, "attachments"),
  log: (_level, msg, extra) => console.error(msg, extra ?? ""), transport: new DiscordJsTransport(), dashboardUrl: "http://127.0.0.1:4318",
});

interface Issue {
  identifier: string; title: string; description: string | null; url: string; priority: number;
  state: { type: string; name: string }; project: { id: string; name: string } | null; labels: { nodes: { name: string }[] };
}
const token = await s.linear.accessToken();
const res = await fetch("https://api.linear.app/graphql", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ query: `query { issues(first: 250, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes {
    identifier title description url priority state { type name } project { id name } labels { nodes { name } } } } }` }),
});
const body = (await res.json()) as { data?: { issues: { nodes: Issue[] } }; errors?: unknown };
if (!body.data) throw new Error(`Linear: ${JSON.stringify(body.errors)}`);
const stored = s.linear.stored();
const existing = new Set(s.tickets.list().map((t) => t.external?.key).filter(Boolean));

for (const issue of body.data.issues.nodes.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
  // Issues outside every project are Linear's own onboarding samples here ("Get familiar with Linear").
  if (!issue.project) {
    console.log(`skip ${issue.identifier}: no project (${issue.title})`);
    continue;
  }
  if (existing.has(issue.identifier)) {
    console.log(`skip ${issue.identifier}: already imported`);
    continue;
  }
  const bug = issue.labels.nodes.some((l) => /^(bug|缺陷|错误)$/i.test(l.name.trim()));
  const project = issue.project ? s.projects.byLinearProject(issue.project.id) : null;
  const place = issue.project?.id === stored.sandboxProjectId ? { space: "sandbox" as const, kind: "experiment" as const }
    : project ? { space: "project" as const, projectId: project.id, kind: bug ? "bug" as const : "feature" as const }
    : { space: "ideas" as const, kind: "research" as const };
  // Still handed to agentSwarm: stop its mission first (it is done over, from the board).
  const session = db.sqlite.prepare("select mission_id from linear_sessions where issue_key = ? and status = 'active'").get(issue.identifier) as { mission_id: string | null } | undefined;
  console.log(`${dry ? "would import" : "import"} ${issue.identifier} (${issue.state.name}, ${issue.project?.name ?? "no project"}) → ${place.space}${"projectId" in place ? ` ${project!.name}` : ""} ${place.kind}${session?.mission_id ? "; stopping its mission" : ""}: ${issue.title}`);
  if (dry) continue;
  if (session?.mission_id) {
    const m = s.missions.view(session.mission_id);
    if (m.stage !== "done" && m.stage !== "cancelled") s.missions.cancel("linear-import", session.mission_id);
  }
  const t = s.tickets.create("linear-import", {
    ...place, title: issue.title.slice(0, 200), description: (issue.description ?? "").slice(0, 8000), priority: issue.priority, status: "backlog",
  }, Date.now(), null, { key: issue.identifier, url: issue.url });
  console.log(`  → ${t.key}`);
}
// Nothing may keep running in this process (the bridge's timers, Discord).
process.exit(0);
