import { describe, expect, it } from "vitest";

import { dotLabelOf, dotStatusOf } from "./conversation-status";

describe(dotStatusOf, () => {
  it("reads ended, waiting, live and paused in priority order", () => {
    expect([
      dotStatusOf({ status: "running", pendingApprovals: 0 }),
      dotStatusOf({ status: "idle", pendingApprovals: 0 }),
      dotStatusOf({ status: "running", pendingApprovals: 1 }),
      dotStatusOf({ status: "paused", pendingApprovals: 0 }),
      dotStatusOf({ status: "archived", pendingApprovals: 0 }),
    ]).toStrictEqual(["live", "live", "waiting", "paused", "paused"]);
  });

  it("reads a lost conversation as error over every other state", () => {
    expect([
      dotStatusOf({ status: "running", pendingApprovals: 1 }, true),
      dotStatusOf({ status: "paused", pendingApprovals: 0 }, true),
    ]).toStrictEqual(["error", "error"]);
  });
});

describe(dotLabelOf, () => {
  it("names each state, with resuming ahead of paused", () => {
    expect([
      dotLabelOf({ status: "running", pendingApprovals: 0 }),
      dotLabelOf({ status: "idle", pendingApprovals: 0 }),
      dotLabelOf({ status: "idle", pendingApprovals: 2 }),
      dotLabelOf({ status: "paused", pendingApprovals: 0 }),
      dotLabelOf({ status: "paused", pendingApprovals: 0 }, false, true),
      dotLabelOf({ status: "archived", pendingApprovals: 0 }),
      dotLabelOf({ status: "running", pendingApprovals: 0 }, true),
    ]).toStrictEqual([
      "Running",
      "Idle",
      "Waiting for you",
      "Paused",
      "Resuming",
      "Archived",
      "Unreachable",
    ]);
  });
});
