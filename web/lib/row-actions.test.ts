import { describe, expect, it } from "vitest";

import { byPinThenRecency, rowActionsOf } from "./row-actions";

const of = (
  status: "running" | "idle" | "paused" | "archived",
  extra: { pausing?: boolean; pinnedAt?: number } = {},
  resuming = false
) =>
  rowActionsOf({ status, pausing: extra.pausing ?? false, ...extra }, resuming);

describe(rowActionsOf, () => {
  it("offers Pause with a Seat, Resume when paused, and Unarchive alone when archived", () => {
    expect(of("idle")).toStrictEqual({
      leading: "pin",
      trailing: ["pause", "archive"],
    });
    expect(of("running", { pausing: true }).trailing).toStrictEqual([
      "archive",
    ]);
    expect(of("paused").trailing).toStrictEqual(["resume", "archive"]);
    expect(of("paused", {}, true).trailing).toStrictEqual(["archive"]);
    expect(of("archived", { pinnedAt: 5 })).toStrictEqual({
      leading: "unpin",
      trailing: ["unarchive"],
    });
  });
});

describe(byPinThenRecency, () => {
  it("lists pinned first, the most recently pinned on top, then newest first", () => {
    const rows = [
      { id: 1, createdAt: 1 },
      { id: 2, createdAt: 2, pinnedAt: 10 },
      { id: 3, createdAt: 3 },
      { id: 4, createdAt: 4, pinnedAt: 20 },
    ];
    expect(rows.toSorted(byPinThenRecency).map((row) => row.id)).toStrictEqual([
      4, 2, 3, 1,
    ]);
  });
});
