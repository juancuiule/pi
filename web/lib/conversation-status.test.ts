import { describe, expect, it } from "vitest";

import {
  consoleSummaryOf,
  dotLabelOf,
  dotStatusOf,
  titleWith,
} from "./conversation-status";

describe(dotStatusOf, () => {
  it("reads ended, waiting, running, live and paused in priority order", () => {
    expect([
      dotStatusOf({ status: "running", pendingApprovals: 0 }),
      dotStatusOf({ status: "idle", pendingApprovals: 0 }),
      dotStatusOf({ status: "running", pendingApprovals: 1 }),
      dotStatusOf({ status: "paused", pendingApprovals: 0 }),
      dotStatusOf({ status: "archived", pendingApprovals: 0 }),
    ]).toStrictEqual(["running", "live", "waiting", "paused", "paused"]);
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

describe(consoleSummaryOf, () => {
  const idle = { id: 1, status: "idle", pendingApprovals: 0 } as const;
  const running = { id: 2, status: "running", pendingApprovals: 0 } as const;
  const waiting = { id: 3, status: "running", pendingApprovals: 1 } as const;
  const failed = {
    id: 4,
    status: "idle",
    pendingApprovals: 0,
    attention: { reason: "model_error" },
  } as const;

  it("reads idle with nothing going, and running over idle", () => {
    expect(consoleSummaryOf([])).toStrictEqual({
      status: "idle",
      attention: 0,
    });
    expect(consoleSummaryOf([idle, running])).toStrictEqual({
      status: "running",
      attention: 0,
    });
  });

  it("puts a wait over a failure, and counts both", () => {
    expect(consoleSummaryOf([running, failed])).toStrictEqual({
      status: "error",
      attention: 1,
    });
    expect(consoleSummaryOf([failed, waiting, running])).toStrictEqual({
      status: "waiting",
      attention: 2,
    });
  });

  it("follows the dots: an ended conversation is an error, an archived one is left out", () => {
    expect(consoleSummaryOf([idle], { 1: true })).toStrictEqual({
      status: "error",
      attention: 1,
    });
    expect(consoleSummaryOf([{ ...failed, status: "archived" }])).toStrictEqual(
      { status: "idle", attention: 0 }
    );
  });
});

describe(titleWith, () => {
  it("prefixes the count only when something needs the person", () => {
    expect(
      titleWith("Skills · effect-pi", { status: "running", attention: 0 })
    ).toBe("Skills · effect-pi");
    expect(
      titleWith("Skills · effect-pi", { status: "waiting", attention: 2 })
    ).toBe("(2) Skills · effect-pi");
  });
});
