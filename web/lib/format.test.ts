import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  messageTime,
  relativeTime,
} from "./format";

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

describe(formatDuration, () => {
  it("shows tenths under ten seconds, whole seconds under a minute, then minutes", () => {
    const cases: [number, string][] = [
      [0, "0s"],
      [-5, "0s"],
      [400, "0.4s"],
      [2400, "2.4s"],
      [9999, "10s"],
      [42_000, "42s"],
      [65_000, "1m 5s"],
      [600_000, "10m 0s"],
    ];
    expect(cases.map(([input]) => formatDuration(input))).toStrictEqual(
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

describe(messageTime, () => {
  // Local-time constructions: the format is a clock reading, so the zone must not matter.
  const now = new Date(2025, 5, 15, 12, 0).getTime();

  it("is a clock time on the same day, a date and time beyond it", () => {
    const cases: [number, string][] = [
      [new Date(2025, 5, 15, 9, 5).getTime(), "9:05 AM"],
      [new Date(2025, 5, 14, 9, 5).getTime(), "Jun 14, 9:05 AM"],
      [new Date(2025, 0, 2, 23, 30).getTime(), "Jan 2, 11:30 PM"],
      [new Date(2024, 11, 31, 9, 5).getTime(), "Dec 31, 2024, 9:05 AM"],
      [new Date(2026, 0, 2, 9, 5).getTime(), "Jan 2, 2026, 9:05 AM"],
    ];
    expect(cases.map(([then]) => messageTime(then, now))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});

describe(formatBytes, () => {
  it("rounds to the unit people read", () => {
    expect([820, 14_500, 3_355_443, 26_214_400].map(formatBytes)).toStrictEqual(
      ["820 B", "14 KB", "3.2 MB", "25 MB"]
    );
  });
});
