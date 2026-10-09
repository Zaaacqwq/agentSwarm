import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_TEMPLATES } from "@hive/core";
import type { TurnInput } from "../src/agents/runtime/agent-runtime.ts";
import type { GitHubPort, PullRequestInput } from "../src/git-relay/github.ts";
import { buildWorld, callTool, channelOf } from "./fakes.ts";
import { localBackend } from "./local-backend.ts";

type World = Awaited<ReturnType<typeof buildWorld>>;

async function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

async function remote(): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hive-remote-")));
  const src = join(base, "src");
  mkdirSync(src);
  await sh(src, "git", "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# app\n");
  await sh(src, "git", "add", ".");
  await sh(src, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  await sh(base, "git", "clone", "-q", "--bare", src, "remote.git");
  return join(base, "remote.git");
}

/** GitHub stand-in: one PR per head branch; tests flip PR states to simulate merges. */
function fakeGitHub() {
  const prs = new Map<string, { input: PullRequestInput; state: "open" | "merged" | "closed"; comments: string[] }>();
  const port: GitHubPort = {
    async createPullRequest(input) {
      const url = `https://github.example/${input.repo}/pull/${input.head.replaceAll("/", "-")}`;
      if (!prs.has(url)) prs.set(url, { input, state: "open", comments: [] });
      return url;
    },
    async status(url) {
      return { state: prs.get(url)!.state, checksFailed: false };
    },
    async view(url) {
      const pr = prs.get(url)!;
      return { title: pr.input.title, state: pr.state, files: [{ path: "feat.txt", additions: 1, deletions: 0 }], diff: "+feature", checks: "no checks" };
    },
    async comment(url, body) {
      prs.get(url)!.comments.push(body);
    },
  };
  return { port, prs };
}

const HANDOFF_NOTES = [
  "## 背景", "Feature two adds feat-2.txt.",
  "## 已完成", "Wrote the first line.",
  "## 未完成与下一步", "Add the second line, push, open the PR.",
  "## 分支与状态", "WIP pushed on the task branch.",
  "## 如何验证", "cat feat-2.txt shows two lines.",
  "## 注意事项", "None.",
].join("\n");

describe("task workflow", () => {
  test("lead plans, person approves, devs build in parallel, review, dependency, handoff, merge", async () => {
    const { backend } = localBackend();
    const gh = fakeGitHub();
    const log: Record<string, string[]> = {};
    const note = (who: string, text: string) => (log[who] ??= []).push(text);
    const run = async (input: TurnInput, name: string, args: Record<string, unknown> = {}) => {
      const r = await callTool(input, name, args);
      note(input.agent.name, `${name}: ${r.text.split("\n")[0]}`);
      return r.text;
    };
    let reviews = 0;
    let world!: World;
    world = await buildWorld({
      backend,
      github: gh.port,
      script: async (input) => {
        const p = input.prompt;
        const me = input.agent.name;
        if (me === "Lead") {
          if (p.includes("(person): plan")) {
            await run(input, "task_create", { title: "Feature one", description: "Add feat-1.txt", acceptance: ["feat-1.txt exists"], repo: "app" });
            await run(input, "task_create", { title: "Feature two", description: "Add feat-2.txt with two lines", acceptance: ["two lines"], repo: "app" });
            await run(input, "task_create", { title: "Feature three", description: "Add feat-3.txt", acceptance: ["feat-3.txt exists"], repo: "app", depends_on: ["T-1"] });
            await run(input, "task_assign", { task: "T-1", agent: "Dev1", reviewer: "Rev" });
          }
          if (p.includes("(person): assign")) {
            await run(input, "task_assign", { task: "T-1", agent: "Dev1", reviewer: "Rev" });
            await run(input, "task_assign", { task: "T-2", agent: "Dev2", reviewer: "Rev" });
            await run(input, "task_assign", { task: "T-3", agent: "Dev2", reviewer: "Rev" });
          }
          return;
        }
        if (me === "Dev1" || me === "Dev2") {
          const assigned = /you are assigned T-(\d+)/.exec(p)?.[1];
          const handed = /Handoff of T-(\d+) to @/.exec(p)?.[1];
          const changes = /requested changes on T-(\d+)/.exec(p)?.[1];
          const n = assigned ?? handed ?? changes;
          if (!n) return;
          const started = await run(input, "task_start", { task: `T-${n}` });
          if (started.includes("waiting on")) {
            await run(input, "task_comment", { task: `T-${n}`, body: "Blocked on a dependency; will start when it is done." });
            return;
          }
          if (n === "2" && me === "Dev2") {
            await run(input, "ws_write", { path: "feat-2.txt", content: "line one\n" });
            await run(input, "task_handoff", { task: "T-2", to: "Dev1", notes: "too short" });
            await run(input, "task_handoff", { task: "T-2", to: "Dev1", notes: HANDOFF_NOTES });
            return;
          }
          if (n === "2") {
            note(me, `resumed file: ${(await run(input, "ws_read", { path: "feat-2.txt" })).includes("line one")}`);
            await run(input, "ws_write", { path: "feat-2.txt", content: "line one\nline two\n" });
          } else if (changes) {
            await run(input, "ws_write", { path: `feat-${n}.txt`, content: "feature, revised\n" });
          } else {
            await run(input, "ws_write", { path: `feat-${n}.txt`, content: "feature\n" });
          }
          await run(input, "git_commit", { message: `feat: T-${n}` });
          await run(input, "git_push");
          if (changes) await run(input, "task_update", { task: `T-${n}`, status: "in_review", note: "addressed review" });
          else await run(input, "pr_create", { title: `T-${n}`, body: "Implements the task." });
          return;
        }
        if (me === "Rev") {
          const n = /PR for T-(\d+)|addressed review on T-(\d+)/.exec(p)?.[1] ?? /T-(\d+)/.exec(p)?.[1];
          if (!n || !p.includes("please review")) return;
          await run(input, "pr_view", { task: `T-${n}` });
          await run(input, "pr_comment", { task: `T-${n}`, body: "Looks fine." });
          const first = n === "1" && reviews++ === 0;
          await run(input, "task_review", { task: `T-${n}`, decision: first ? "request_changes" : "approve", notes: first ? "Please revise the wording." : "LGTM" });
        }
      },
    });
    const w = world;
    await w.repos.create(w.user, { githubFullName: "zaaac/app", remoteUrl: await remote() });
    const ws1 = await w.workstations.create(w.user, { name: "Bench 1", osUser: "ws-1" });
    const ws2 = await w.workstations.create(w.user, { name: "Bench 2", osUser: "ws-2" });
    const make = (name: string, role: keyof typeof ROLE_TEMPLATES) => w.agents.create(w.user, {
      name, role, instructions: "", endpointId: w.endpoint.id, modelId: "fake", thinkingLevel: "off",
      grants: ROLE_TEMPLATES[role].grants.map((g) => ({ ...g })),
    });
    const lead = make("Lead", "lead");
    const dev1 = make("Dev1", "dev");
    const dev2 = make("Dev2", "dev");
    make("Rev", "reviewer");
    w.workstations.bind(w.user, dev1.id, ws1.id);
    w.workstations.bind(w.user, dev2.id, ws2.id);
    const leadDm = w.chat.openDm(w.user, lead.id);

    // 1. The lead proposes three tasks; it cannot assign before approval.
    w.chat.postUserMessage(w.user, leadDm.id, "plan three features");
    await w.manager.idle();
    let tasks = w.tasks.list(w.user.orgId);
    expect(tasks.map((t) => [t.number, t.status, t.approved])).toEqual([[1, "backlog", false], [2, "backlog", false], [3, "backlog", false]]);
    expect(log.Lead!.at(-1)).toContain("waiting for a person to approve");
    expect(tasks[2]!.dependsOn).toEqual([tasks[0]!.id]);

    // 2. A person approves; the lead assigns; devs work in parallel on their own workstations.
    for (const t of tasks) w.tasks.approve(w.user, t.id);
    w.chat.postUserMessage(w.user, leadDm.id, "assign them");
    await w.manager.idle();

    tasks = w.tasks.list(w.user.orgId);
    const t1 = tasks[0]!;
    const t2 = tasks[1]!;
    const t3 = tasks[2]!;
    // T-3 was blocked by its dependency on T-1.
    expect(log.Dev2!.some((l) => l.includes("task_start") && l.includes("waiting on T-1"))).toBe(true);
    // T-2 was handed off: the incomplete note was refused, the full one accepted, and Dev1 resumed the WIP.
    expect(log.Dev2!.some((l) => l.includes("task_handoff") && l.includes("missing"))).toBe(true);
    expect(t2.assigneeAgentId).toBe(dev1.id);
    expect(log.Dev1).toContain("resumed file: true");
    // Review: T-1 had changes requested once, then was approved; T-2 approved first time.
    expect(gh.prs.size).toBe(2);
    expect(t1.status).toBe("in_review");
    expect(t2.status).toBe("in_review");
    const t1Events = w.tasks.detail(w.user.orgId, t1.id).events.map((e) => e.kind);
    expect(t1Events).toEqual(expect.arrayContaining(["created", "approved", "assigned", "started", "pr_opened", "review:request_changes", "review:approve"]));
    expect([...gh.prs.values()].every((pr) => pr.comments.length > 0)).toBe(true);
    const t2Branch = t2.branch!;
    expect(t2Branch).toMatch(/^hive\/t2\//);

    // 3. Merging T-1 finishes it, cleans its worktree, and unblocks T-3.
    gh.prs.get(t1.prUrl!)!.state = "merged";
    expect(await w.tasks.syncPullRequests()).toBe(1);
    expect(w.tasks.list(w.user.orgId)[0]!.status).toBe("done");
    await Bun.sleep(50);
    expect(w.repos.taskWorktrees(t1.id)).toHaveLength(0);
    await w.manager.idle();
    expect(w.tasks.list(w.user.orgId)[2]!.status).toBe("in_review");

    // 4. A closed (not merged) PR sends the task back.
    gh.prs.get(t2.prUrl!)!.state = "closed";
    await w.tasks.syncPullRequests();
    expect(w.tasks.list(w.user.orgId)[1]!.status).toBe("in_progress");

    const channel = w.chat.listMessages(w.user, t1.channelId!, {}).messages.map((m) => m.body);
    expect(channel.some((b) => b.includes("approved T-1. Ready for a person to merge"))).toBe(true);
    expect(channel.at(-1)).toContain("T-1 merged");
  });
});

describe("task permissions and budget", () => {
  test("role checks, dependency cycles, and an optional budget that blocks", async () => {
    const results: string[] = [];
    let world!: World;
    world = await buildWorld({
      script: async (input) => {
        if (input.agent.name === "Dev") {
          results.push((await callTool(input, "task_assign", { task: "T-1", agent: "Dev" })).text);
          results.push((await callTool(input, "task_update", { task: "T-1", status: "done" })).text);
          results.push((await callTool(input, "task_start", { task: "T-2" })).text);
          await callTool(input, "send_message", { channel_id: channelOf(input), body: "noted" });
          input.onEvent({ kind: "usage", provider: "p", model: "m", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.6 });
        }
      },
    });
    const w = world;
    const dev = w.agents.create(w.user, { name: "Dev", role: "dev", instructions: "", endpointId: w.endpoint.id, modelId: "fake", thinkingLevel: "off", grants: ROLE_TEMPLATES.dev.grants.map((g) => ({ ...g })) });
    const t1 = w.tasks.create({ kind: "user", user: w.user }, { title: "One", description: "d", assigneeAgentId: dev.id, budgetUsd: 0.5 });
    const t2 = w.tasks.create({ kind: "user", user: w.user }, { title: "Two", description: "d" });
    expect(t1.status).toBe("todo");
    expect(() => w.tasks.update(w.user, t1.id, { dependsOn: [t2.id] })).not.toThrow();
    expect(() => w.tasks.update(w.user, t2.id, { dependsOn: [t1.id] })).toThrow("cycle");
    expect(() => w.tasks.update(w.user, t1.id, { status: "in_review" })).toThrow("Cannot move");
    await w.manager.idle();

    // Devs are not granted task_assign at all.
    expect(results[0]).toContain("Tool not found");
    expect(results[1]).toContain("cannot move T-1 from todo to done");
    expect(results[2]).toContain("not assigned to you");
    const after = w.tasks.list(w.user.orgId)[0]!;
    expect(after.spentUsd).toBeCloseTo(0.6);
    expect(after.status).toBe("blocked");
    expect(w.chat.listMessages(w.user, after.channelId!, {}).messages.at(-1)!.body).toContain("budget and is blocked");
  });
});
