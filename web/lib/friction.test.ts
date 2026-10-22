import type { FrictionEntryInfo } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { frictionCounts, frictionView } from "./friction";

const entry = (
  id: string,
  createdAt: number,
  status: FrictionEntryInfo["status"] = "open"
): FrictionEntryInfo => ({
  id,
  scope: "platform",
  title: `Entry ${id}`,
  whatHappened: "It broke.",
  expectedOrWhyItHurt: "It should not.",
  conversationId: 1,
  createdAt,
  status,
  notes: [],
});

const ids = (entries: readonly FrictionEntryInfo[]) =>
  entries.map((each) => each.id);

// Filing order, as GET /api/friction answers.
const log = [
  entry("f1", 100, "resolved"),
  entry("f2", 200),
  entry("f3", 300, "dismissed"),
  entry("f4", 400),
  entry("f5", 500, "resolved"),
];

describe(frictionView, () => {
  it("shows each status's entries in its own view, newest first", () => {
    expect(ids(frictionView(log, "open"))).toStrictEqual(["f4", "f2"]);
    expect(ids(frictionView(log, "resolved"))).toStrictEqual(["f5", "f1"]);
    expect(ids(frictionView(log, "dismissed"))).toStrictEqual(["f3"]);
  });

  it("shows every entry under all, newest first", () => {
    expect(ids(frictionView(log, "all"))).toStrictEqual([
      "f5",
      "f4",
      "f3",
      "f2",
      "f1",
    ]);
  });

  it("does not reorder the list it was given", () => {
    const before = ids(log);
    frictionView(log, "all");
    expect(ids(log)).toStrictEqual(before);
  });
});

describe(frictionCounts, () => {
  it("counts the entries each view shows", () => {
    expect(frictionCounts(log)).toStrictEqual({
      open: 2,
      resolved: 2,
      dismissed: 1,
      all: 5,
    });
  });

  it("counts zero for every view of an empty log", () => {
    expect(frictionCounts([])).toStrictEqual({
      open: 0,
      resolved: 0,
      dismissed: 0,
      all: 0,
    });
  });
});
