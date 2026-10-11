import { describe, expect, it } from "vitest";

import { formatCost, formatTokens, relativeTime } from "./format";

describe(formatCost, () => {
  it("formats zero, fractions of a cent and normal amounts", () => {
    const cases: [number, string][] = [
      [0, "$0"],
      [-1, "$0"],
      [0.001, "<$0.01"],
      [0.0099, "<$0.01"],
      [0.01, "$0.01"],
      [1.234, "$1.23"],
      [1.2, "$1.20"],
    ];
    expect(cases.map(([input]) => formatCost(input))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});

describe(formatTokens, () => {
  it("shows exact counts under a thousand", () => {
    expect([
      formatTokens(0),
      formatTokens(950),
      formatTokens(999),
    ]).toStrictEqual(["0", "950", "999"]);
  });

  it("abbreviates thousands and millions with one trimmed decimal", () => {
    const cases: [number, string][] = [
      [1000, "1k"],
      [12_000, "12k"],
      [12_300, "12.3k"],
      [1_000_000, "1M"],
      [1_200_000, "1.2M"],
    ];
    expect(cases.map(([input]) => formatTokens(input))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});

describe(relativeTime, () => {
  const now = new Date("2025-06-15T12:00:00Z").getTime();
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("buckets recent times", () => {
    const cases: [number, string][] = [
      [0, "just now"],
      [44_000, "just now"],
      [45_000, "1m ago"],
      [3 * 60_000, "3m ago"],
      [2 * 3_600_000, "2h ago"],
      [4 * 86_400_000, "4d ago"],
      [7 * 86_400_000, "7d ago"],
    ];
    expect(cases.map(([ms]) => ago(ms))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });

  it("falls back to a short date beyond a week", () => {
    expect(relativeTime(new Date("2025-06-01T12:00:00Z").getTime(), now)).toBe(
      "Jun 1"
    );
  });

  it("never goes negative", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});
