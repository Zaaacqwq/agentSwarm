import { expect, test } from "bun:test";
import { parseDuration } from "../src/duration.ts";

test("parses compound durations", () => {
  expect(parseDuration("90s")).toBe(90);
  expect(parseDuration("5m")).toBe(300);
  expect(parseDuration("1h30m")).toBe(5400);
  expect(parseDuration("2d")).toBe(172_800);
  expect(() => parseDuration("10x")).toThrow();
});
