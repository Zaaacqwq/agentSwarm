import { expect, test } from "bun:test";
import { titleCase } from "../src/title-case.ts";

test("capitalises words but not small ones, except first", () => {
  expect(titleCase("the lord of the rings")).toBe("The Lord of the Rings");
  expect(titleCase("A TALE OF TWO CITIES")).toBe("A Tale of Two Cities");
  expect(titleCase("hello")).toBe("Hello");
});
