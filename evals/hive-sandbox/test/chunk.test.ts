import { expect, test } from "bun:test";
import { chunk } from "../src/chunk.ts";

test("keeps the remainder", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
  expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  expect(() => chunk([1], 0)).toThrow();
});
