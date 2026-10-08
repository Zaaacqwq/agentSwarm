import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";

test("lowercases and collapses separators", () => {
  expect(slugify("Hello World")).toBe("hello-world");
  expect(slugify("  Many   spaces & symbols!! ")).toBe("many-spaces-symbols");
  expect(slugify("--Already-Slugged--")).toBe("already-slugged");
});
