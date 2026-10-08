import { expect, test } from "bun:test";
import { rangeSum } from "../src/range-sum.ts";

test("includes both ends", () => {
  expect(rangeSum(1, 5)).toBe(15);
  expect(rangeSum(3, 3)).toBe(3);
  expect(rangeSum(-2, 2)).toBe(0);
});
