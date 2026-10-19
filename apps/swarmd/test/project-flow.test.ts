import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { harness, type Harness } from "./harness.ts";
import { projectFilePath } from "../src/projects/project-service.ts";
import { secretValues } from "../src/relay/relay.ts";

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const SECRET = "sk_live_example_0123456789abcdef";

describe("project files and profiles", () => {
  let h: Harness;
  afterEach(() => h?.close());

  test("paths: relative, no ., .., empty or .git parts in any case", () => {
    for (const ok of ["Local.xcconfig", "DoFocus/Secrets.plist", ".env", "web/.env.local", ".gitignore"]) assert.equal(projectFilePath(ok), ok, ok);
    for (const bad of ["../x", "a/../b", ".git/config", "./.env", ".GIT/config", "a/.Git/x", "a//b", "/etc/x", "a/", " x", "x\\y"]) assert.equal(projectFilePath(bad), null, bad);
  });

  test("secret values: the distinctive values of key = value lines, not the short ones", () => {
    const v = secretValues([{ content: `API_KEY = ${SECRET}\nDEBUG = true\nHOST="http://localhost:3000/api/v1"\n"token": "abcdefghijklmnop",\n` }]);
    assert.deepEqual(v.sort(), [SECRET, "abcdefghijklmnop"].sort());
  });

  test("an agent sees the profile and the local file, but neither the file nor its value can be pushed", async () => {
    h = await harness();
    const { cookie, projectId, agentId } = await h.ready();
    assert.equal((await h.api("PUT", `/api/projects/${projectId}/files`, { path: "./.env", content: "x" }, cookie)).status, 400);
    const put = await h.api("PUT", `/api/projects/${projectId}/files`, { path: ".env", content: `API_KEY = ${SECRET}\n` }, cookie);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.files.map((f: { path: string }) => f.path), [".env"]);
    assert.ok(!JSON.stringify(put.body).includes(SECRET), "the content never comes back");
    await h.api("PUT", `/api/projects/${projectId}/profile`, { profile: { test: "node --test", rules: "Never deploy." } }, cookie);

    let prompt = "";
    let sawFile = "";
    let forced = "";
    let copied = "";
    const lastResult = (c: TranscriptContext) => JSON.stringify(c.messages.at(-1) ?? "");
    h.scriptAgents({
      Dev: [
        (c) => {
          prompt = JSON.stringify(c.messages.filter((m) => m.role === "system"));
          return call("ws_read", { path: ".env" });
        },
        (c) => {
          sawFile = lastResult(c);
          return call("ws_bash", { command: "git add -f .env && git commit -q -m 'add env' && echo committed" });
        },
        call("git_push", {}),
        (c) => {
          forced = lastResult(c);
          return call("ws_bash", { command: "git reset -q HEAD~1 && grep API_KEY .env | cut -d' ' -f3 > notes.txt && git add notes.txt && git commit -q -m notes && echo ok" });
        },
        call("git_push", {}),
        (c) => {
          copied = lastResult(c);
          return call("report", { summary: "tried", tests: "-", unfinished: [] });
        },
      ],
    });
    const run = (await h.api("POST", `/api/agents/${agentId}/runs`, { title: "Env", brief: "Look at the env file." }, cookie)).body;
    await h.services.runs.settled(run.id);
    assert.match(prompt, /About this project \(from the person\)/);
    assert.match(prompt, /Test: node --test/);
    assert.match(prompt, /Never deploy\./);
    assert.match(sawFile, new RegExp(SECRET), "the file is in the worktree");
    assert.match(forced, /local files must not be committed \(\.env\)/);
    assert.match(copied, /value from the project's local files/);
    assert.ok(!h.remoteBranches().includes(run.branch), "nothing reached GitHub");
  });
});
