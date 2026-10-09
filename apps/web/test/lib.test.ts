import { describe, expect, test } from "bun:test";
import { avatarTraits, hashSeed } from "../src/lib/avatar.ts";
import { preview, relativeTime, tokens, usd } from "../src/lib/format.ts";

describe("avatar", () => {
  test("is deterministic and in range", () => {
    expect(avatarTraits("seed-a")).toEqual(avatarTraits("seed-a"));
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
    for (const seed of ["x", "y", "z", "agent-123"]) {
      const t = avatarTraits(seed);
      expect(t.hue).toBeGreaterThanOrEqual(0);
      expect(t.hue).toBeLessThan(360);
      expect(t.tilt).toBeGreaterThanOrEqual(-4);
      expect(t.tilt).toBeLessThanOrEqual(4);
    }
  });
});

describe("format", () => {
  test("preview strips markdown and truncates", () => {
    expect(preview("Got it. You said **alpha73**.\n\n- I run on a *fake* model")).toBe("Got it. You said alpha73. I run on a fake model");
    expect(preview("see [docs](https://x.y) and `code`")).toBe("see docs and code");
    expect(preview("```ts\nconst a = 1\n```")).toBe("[code]");
    expect(preview("call `send_message` and _really_ mean it")).toBe("call send_message and really mean it");
    expect(preview("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`);
  });

  test("relative time, tokens and dollars", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
    expect(tokens(950)).toBe("950");
    expect(tokens(1500)).toBe("1.5k");
    expect(tokens(25_000)).toBe("25k");
    expect(tokens(2_500_000)).toBe("2.5M");
    expect(usd(0)).toBe("$0");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(1.234)).toBe("$1.23");
  });
});
