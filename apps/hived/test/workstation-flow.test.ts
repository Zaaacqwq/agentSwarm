import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMUNICATION_PACK_ID, WORKSTATION_PACK_ID } from "@hive/tools";
import type { TurnInput } from "../src/agents/runtime/agent-runtime.ts";
import type { GitHubPort, PullRequestInput } from "../src/git-relay/github.ts";
import { buildWorld, callTool, channelOf, waitForAbort } from "./fakes.ts";
import { localBackend } from "./local-backend.ts";

const GRANTS = [
  { toolpackId: COMMUNICATION_PACK_ID, toolName: "*" },
  { toolpackId: WORKSTATION_PACK_ID, toolName: "*" },
];

async function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

/** A bare repo standing in for GitHub, with a deliberately broken calc.txt and a check script. */
async function fakeRemote(): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-remote-")));
  const src = join(base, "src");
  mkdirSync(src);
  await sh(src, "git", "init", "-q", "-b", "main");
  writeFileSync(join(src, "calc.txt"), "2+2=5\n");
  writeFileSync(join(src, "check.sh"), 'grep -q "2+2=4" calc.txt && echo "check passed" || { echo "check failed"; exit 1; }\n');
  await sh(src, "git", "add", ".");
  await sh(src, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  await sh(base, "git", "clone", "-q", "--bare", src, "remote.git");
  return join(base, "remote.git");
}

function fakeGitHub() {
  const prs: PullRequestInput[] = [];
  const port: GitHubPort = {
    async createPullRequest(input) {
      prs.push(input);
      return `https://github.example/${input.repo}/pull/${prs.length}`;
    },
  };
  return { port, prs };
}

async function setup(script: (input: TurnInput, w: Awaited<ReturnType<typeof buildWorld>>) => Promise<void>) {
  const { backend } = localBackend();
  const github = fakeGitHub();
  let world: Awaited<ReturnType<typeof buildWorld>> | null = null;
  const w = await buildWorld({ backend, github: github.port, script: (input) => script(input, world!) });
  world = w;
  const remote = await fakeRemote();
  await w.repos.create(w.user, { githubFullName: "zaaac/hive-sandbox", remoteUrl: remote });
  const ws = await w.workstations.create(w.user, { name: "Bench 1", osUser: "ws-1" });
  return { w, ws, remote, github };
}

const text = async (input: TurnInput, name: string, args: Record<string, unknown> = {}) => (await callTool(input, name, args)).text;

describe("workstation coding loop", () => {
  test("an agent checks out, fixes, verifies, commits, pushes and opens a PR", async () => {
    const seen: string[] = [];
    const { w, ws, remote, github } = await setup(async (input) => {
      seen.push(await text(input, "ws_where"));
      seen.push(await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "fix-calc" }));
      seen.push(await text(input, "ws_read", { path: "calc.txt" }));
      seen.push(await text(input, "ws_bash", { command: "sh check.sh" }));
      seen.push(await text(input, "ws_edit", { path: "calc.txt", old_text: "2+2=5", new_text: "2+2=4" }));
      seen.push(await text(input, "ws_bash", { command: "sh check.sh" }));
      seen.push(await text(input, "git_status"));
      seen.push(await text(input, "git_commit", { message: "fix: correct 2+2" }));
      seen.push(await text(input, "git_push"));
      seen.push(await text(input, "pr_create", { title: "Fix calc", body: "Corrects the sum." }));
      await callTool(input, "send_message", { channel_id: channelOf(input), body: "Done." });
    });
    const agent = w.makeAgent("Ada", GRANTS);
    w.workstations.bind(w.user, agent.id, ws.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "fix the calc test");
    await w.manager.idle();

    expect(w.runs.listRuns(w.user.orgId, agent.id)[0]?.status).toBe("succeeded");
    expect(seen[0]).toContain("No active worktree");
    expect(seen[1]).toContain("hive/ada/fix-calc");
    expect(seen[2]).toContain("2+2=5");
    expect(seen[3]).toContain("exit 1");
    expect(seen[5]).toContain("exit 0");
    expect(seen[5]).toContain("check passed");
    expect(seen[6]).toContain("calc.txt");
    expect(seen[8]).toContain("Pushed hive/ada/fix-calc");
    expect(seen[9]).toContain("https://github.example/zaaac/hive-sandbox/pull/1");

    expect(await sh(remote, "git", "show", "hive/ada/fix-calc:calc.txt")).toBe("2+2=4\n");
    expect(github.prs[0]).toMatchObject({ repo: "zaaac/hive-sandbox", head: "hive/ada/fix-calc", base: "main", title: "Fix calc" });
    expect(github.prs[0]!.body).toContain("Merging is left to a human");
    const [push] = w.relay.history(agent.id);
    expect(push).toMatchObject({ status: "pushed", prUrl: "https://github.example/zaaac/hive-sandbox/pull/1" });
    // The write lease belonged to the run and is returned when it ends.
    expect(w.leases.current(ws.id)).toBeNull();
    expect(w.repos.worktreesFor({ agentId: agent.id })).toHaveLength(1);
    expect(w.agents.get(w.user, agent.id).workstationId).toBe(ws.id);
  });

  test("a second agent cannot write while another holds the workstation", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const results: Record<string, string> = {};
    const { w, ws } = await setup(async (input) => {
      results[`${input.agent.name}Checkout`] = await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "work" });
      if (input.agent.name === "Ada") {
        results.adaWrite = await text(input, "ws_write", { path: "a.txt", content: "a" });
        await gate;
      } else {
        results.bobRead = await text(input, "ws_list", { path: "." });
        results.bobWrite = await text(input, "ws_write", { path: "b.txt", content: "b" });
      }
    });
    const ada = w.makeAgent("Ada", GRANTS);
    const bob = w.makeAgent("Bob", GRANTS);
    w.workstations.bind(w.user, ada.id, ws.id);
    w.workstations.bind(w.user, bob.id, ws.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, ada.id).id, "go");
    while (!results.adaWrite) await Bun.sleep(5);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, bob.id).id, "go");
    while (!results.bobWrite && w.manager.stateOf(bob.id) !== "idle") await Bun.sleep(5);
    await Bun.sleep(20);
    releaseFirst();
    await w.manager.idle();

    expect(results.adaWrite).toContain("Wrote");
    // Bob's checkout itself needs the write lease, so Bob is told who holds it.
    expect(results.BobCheckout).toContain("being written by Ada");
    expect(results.bobRead).toContain("No active worktree");
    expect(w.leases.current(ws.id)).toBeNull();
  });

  test("tools explain what is missing instead of failing obscurely", async () => {
    const seen: string[] = [];
    const { w } = await setup(async (input) => {
      seen.push(await text(input, "ws_where"));
      seen.push(await text(input, "ws_read", { path: "x" }));
    });
    const agent = w.makeAgent("Ada", GRANTS);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "go");
    await w.manager.idle();
    expect(seen.every((s) => s.includes("No workstation is assigned"))).toBe(true);
  });

  test("an aborted command releases its heavy slot", async () => {
    const { w, ws } = await setup(async (input) => {
      await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "slow" });
      await Promise.race([text(input, "ws_bash", { command: "sleep 30", timeout_s: 60 }), waitForAbort(input.signal)]);
    });
    const agent = w.makeAgent("Ada", GRANTS);
    w.workstations.bind(w.user, agent.id, ws.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "go");
    while (w.heavy.stats().running === 0) await Bun.sleep(10);
    w.manager.stop(agent.id);
    await w.manager.idle();
    expect(w.runs.listRuns(w.user.orgId, agent.id)[0]?.status).toBe("interrupted");
  });
});

describe("worktree cleanup", () => {
  test("deleting an agent removes its worktrees; prune clears leftovers", async () => {
    const { w, ws } = await setup(async (input) => {
      await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "tmp" });
    });
    const { existsSync } = await import("node:fs");
    const agent = w.makeAgent("Ada", GRANTS);
    w.workstations.bind(w.user, agent.id, ws.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "go");
    await w.manager.idle();
    const layout = w.workstations.backend.layout;
    const dir = join(layout.wsRoot, "ws-1", "worktrees", "hive-sandbox", "ada-tmp");
    expect(existsSync(dir)).toBe(true);
    expect(await w.repos.removeAgentWorktrees(agent.id)).toBe(1);
    expect(existsSync(dir)).toBe(false);

    // A leftover clone with no database row (e.g. after a crash) is pruned.
    const { worktree } = await w.repos.checkout({ orgId: w.user.orgId, agent: { id: agent.id, name: "Bob" }, workstation: { id: ws.id, osUser: "ws-1" }, repoName: "hive-sandbox", slug: "orphan" });
    w.handle.sqlite.run("delete from worktrees where id = ?", [worktree.id]);
    expect(await w.repos.pruneOrphans({ id: ws.id, osUser: "ws-1" })).toEqual(["worktrees/hive-sandbox/bob-orphan"]);
    expect(await w.repos.pruneOrphans({ id: ws.id, osUser: "ws-1" })).toEqual([]);
  });
});

describe("Git Relay checks", () => {
  async function pushWith(edit: (input: TurnInput) => Promise<void>) {
    const outputs: string[] = [];
    const ctx = await setup(async (input) => {
      await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "relay" });
      await edit(input);
      outputs.push(await text(input, "git_push"));
    });
    const agent = ctx.w.makeAgent("Ada", GRANTS);
    ctx.w.workstations.bind(ctx.w.user, agent.id, ctx.ws.id);
    ctx.w.chat.postUserMessage(ctx.w.user, ctx.w.chat.openDm(ctx.w.user, agent.id).id, "go");
    await ctx.w.manager.idle();
    return { ...ctx, agent, outputs };
  }

  test("rejects diffs that contain secrets", async () => {
    const { outputs, remote } = await pushWith(async (input) => {
      await text(input, "ws_write", { path: "config.ts", content: `export const key = "sk-or-v1-${"a".repeat(40)}";\n` });
      await text(input, "git_commit", { message: "add config" });
    });
    expect(outputs[0]).toContain("Possible secrets");
    expect(await sh(remote, "git", "branch", "--list", "hive/*")).toBe("");
  });

  test("rejects pushes with nothing new", async () => {
    const { outputs } = await pushWith(async () => {});
    expect(outputs[0]).toContain("Nothing new to push");
  });

  test("rejects rewriting a branch that was already pushed", async () => {
    const { outputs, w, agent } = await pushWith(async (input) => {
      await text(input, "ws_write", { path: "one.txt", content: "1\n" });
      await text(input, "git_commit", { message: "one" });
      outputs0.push(await text(input, "git_push"));
      await text(input, "ws_bash", { command: "git reset -q --hard HEAD~1 && echo 2 > two.txt && git add . && git -c user.name=x -c user.email=x@x commit -qm two" });
    });
    expect(outputs0[0]).toContain("Pushed");
    expect(outputs[0]).toContain("rewrite published history");
    expect(w.relay.history(agent.id).map((p) => p.status)).toEqual(["rejected", "pushed"]);
  });

  test("pr_create requires a successful push first", async () => {
    const seen: string[] = [];
    const { w, ws } = await setup(async (input) => {
      await text(input, "ws_checkout", { repo: "hive-sandbox", slug: "early" });
      seen.push(await text(input, "pr_create", { title: "t", body: "b" }));
    });
    const agent = w.makeAgent("Ada", GRANTS);
    w.workstations.bind(w.user, agent.id, ws.id);
    w.chat.postUserMessage(w.user, w.chat.openDm(w.user, agent.id).id, "go");
    await w.manager.idle();
    expect(seen[0]).toContain("Push the branch with git_push");
  });
});

const outputs0: string[] = [];
