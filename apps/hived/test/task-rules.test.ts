import { describe, expect, test } from "bun:test";
import { allowedTargets, canTransition, missingHandoffSections, taskSlug } from "../src/tasks/task-rules.ts";

describe("task state machine", () => {
  test("people approve, agents work, only people or merges finish", () => {
    expect(canTransition("backlog", "todo", "user")).toBe(true);
    expect(canTransition("backlog", "todo", "lead")).toBe(false);
    expect(canTransition("todo", "in_progress", "assignee")).toBe(true);
    expect(canTransition("in_progress", "done", "assignee")).toBe(false);
    expect(canTransition("in_review", "done", "system")).toBe(true);
    expect(canTransition("in_review", "in_progress", "reviewer")).toBe(true);
    expect(canTransition("in_review", "done", "reviewer")).toBe(false);
    expect(canTransition("done", "in_progress", "lead")).toBe(false);
    expect(canTransition("todo", "todo", "assignee")).toBe(true);
    expect(allowedTargets("in_progress", "assignee").sort()).toEqual(["blocked", "in_review"]);
  });
});

describe("handoff template", () => {
  const full = [
    "## 背景", "Users want jitter.", "## 已完成", "Wrote the wrapper.", "## 未完成与下一步", "Add tests.",
    "## 分支与状态", "hive/t3/jitter pushed, builds.", "## 如何验证", "bun test test/backoff.test.ts", "## 注意事项", "Keep backoffDelay deterministic.",
  ].join("\n");

  test("accepts all six sections in Chinese or English, headings or label lines", () => {
    expect(missingHandoffSections(full)).toEqual([]);
    const english = "Background: x\nDone: y\nNext steps: z\nBranch: b pushed\nHow to verify: run tests\nCaveats: none";
    expect(missingHandoffSections(english)).toEqual([]);
  });

  test("names what is missing or empty", () => {
    expect(missingHandoffSections("## 背景\nx\n## 已完成\n\n## 如何验证\nrun")).toEqual(["已完成", "未完成与下一步", "分支与状态", "注意事项"]);
    expect(missingHandoffSections("")).toHaveLength(6);
  });
});

test("task slugs are branch-safe", () => {
  expect(taskSlug("Add jitter to backoff!")).toBe("add-jitter-to-backoff");
  expect(taskSlug("中文标题")).toBe("work");
  expect(taskSlug("x".repeat(80))).toHaveLength(40);
});
