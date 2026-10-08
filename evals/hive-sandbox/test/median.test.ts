import { expect, test } from "bun:test";
import { median } from "../src/median.ts";

test("handles odd and even lengths with numeric order", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([10, 9, 100])).toBe(10);
  expect(() => median([])).toThrow();
});
