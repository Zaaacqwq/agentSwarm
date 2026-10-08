import { expect, test } from "bun:test";
import { wordCount } from "../src/word-count.ts";

test("normalises case and punctuation", () => {
  expect(wordCount("The cat. the CAT, a dog!")).toEqual([["cat", 2], ["the", 2], ["a", 1], ["dog", 1]]);
  expect(wordCount("   ")).toEqual([]);
});
