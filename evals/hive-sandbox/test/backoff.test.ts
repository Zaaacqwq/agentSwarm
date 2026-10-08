import { expect, test } from "bun:test";
import { backoffDelay } from "../src/backoff.ts";

test("doubles each attempt and caps", () => {
  expect(backoffDelay(0)).toBe(100);
  expect(backoffDelay(1)).toBe(200);
  expect(backoffDelay(3)).toBe(800);
  expect(backoffDelay(20)).toBe(10_000);
  expect(backoffDelay(2, 50, 150)).toBe(150);
});
