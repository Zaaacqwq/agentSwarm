import { describe, expect, test } from "bun:test";
import { currentUser, parsePasswdLine } from "../src/passwd.ts";

describe("user database lookup", () => {
  test("parses an id -P line", () => {
    expect(parsePasswdLine("ws-1:********:503:501::0:0:Hive Workstation 1:/Users/ws-1:/usr/bin/false\n")).toEqual({ username: "ws-1", uid: 503, home: "/Users/ws-1" });
  });

  test("rejects malformed lines", () => {
    expect(() => parsePasswdLine("")).toThrow();
    expect(() => parsePasswdLine("ws-1:*:x:501::0:0:g:/Users/ws-1:/bin/sh")).toThrow();
    expect(() => parsePasswdLine("ws-1:*:503:501::0:0:g:relative:/bin/sh")).toThrow();
  });

  test("ignores HOME and USER from the environment", async () => {
    const proc = Bun.spawnSync([process.execPath, "-e", `const { currentUser } = await import(${JSON.stringify(`${import.meta.dir}/../src/passwd.ts`)}); console.log(JSON.stringify(currentUser()))`], {
      env: { ...process.env, HOME: "/tmp/not-home", USER: "not-me" },
    });
    const user = JSON.parse(proc.stdout.toString());
    expect(user.uid).toBe(process.getuid!());
    expect(user.home).not.toBe("/tmp/not-home");
    expect(user.username).not.toBe("not-me");
    expect(user).toEqual(currentUser());
  });
});
