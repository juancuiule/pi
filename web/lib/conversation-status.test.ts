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

  it("reads a badly ended last run as error over waiting and live, but under ended", () => {
    expect([
      dotStatusOf({
        status: "idle",
        pendingApprovals: 0,
        attention: { reason: "model_error" },
      }),
      dotStatusOf({
        status: "idle",
        pendingApprovals: 2,
        attention: { reason: "faulted" },
      }),
      dotStatusOf({
        status: "paused",
        pendingApprovals: 0,
        attention: { reason: "repeat_guard" },
      }),
      dotStatusOf(
        {
          status: "idle",
          pendingApprovals: 0,
          attention: { reason: "no_model" },
        },
        true
      ),
    ]).toStrictEqual(["error", "error", "error", "error"]);
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

  it("names an attention reason, with its detail when there is one", () => {
    expect([
      dotLabelOf({
        status: "idle",
        pendingApprovals: 0,
        attention: { reason: "model_error" },
      }),
      dotLabelOf({
        status: "idle",
        pendingApprovals: 0,
        attention: {
          reason: "repeat_guard",
          detail: "Ended the run: the identical bash call was emitted 6 times",
        },
      }),
      dotLabelOf({
        status: "idle",
        pendingApprovals: 1,
        attention: { reason: "no_model" },
      }),
      dotLabelOf(
        {
          status: "idle",
          pendingApprovals: 0,
          attention: { reason: "faulted" },
        },
        true
      ),
    ]).toStrictEqual([
      "Model error",
      "Stopped a repeated call: Ended the run: the identical bash call was emitted 6 times",
      "No model configured",
      "Unreachable",
    ]);
  });
});
