import type { GoalInfo } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  continuationOf,
  goalHeadline,
  goalObjectiveOf,
  goalProgress,
} from "./goal";

const goal: GoalInfo = {
  objective: "Ship it",
  status: "active",
  startedAt: 0,
  turns: 3,
  maxTurns: 20,
  costUsd: 0.12,
  maxCostUsd: 5,
  todos: { completed: 2, total: 5 },
};

describe(goalObjectiveOf, () => {
  it("reads the objective of a goal message only", () => {
    expect(goalObjectiveOf("<goal>\nShip it\n</goal>")).toBe("Ship it");
    expect(goalObjectiveOf("Ship it")).toBeUndefined();
  });
});

describe(continuationOf, () => {
  it("reads an automatic continuation's turn", () => {
    expect(
      continuationOf(
        '<goal_continuation turn="3" of="20">\nKeep working.\n</goal_continuation>'
      )
    ).toStrictEqual({ turn: 3, of: 20 });
    expect(continuationOf("keep going")).toBeUndefined();
  });
});

describe(goalProgress, () => {
  it("joins todos, turns and spend", () => {
    expect(goalProgress(goal)).toBe(
      "2/5 todos · turn 3 of 20 · $0.12 of $5.00"
    );
    expect(
      goalProgress({
        ...goal,
        todos: { completed: 0, total: 0 },
        maxCostUsd: 0,
        costUsd: 0,
      })
    ).toBe("turn 3 of 20 · $0");
  });
});

describe(goalHeadline, () => {
  it("says what the goal does or why it ended", () => {
    expect(goalHeadline(goal, true)).toBe("Working toward the goal");
    expect(goalHeadline(goal, false)).toBe("Goal waiting to continue");
    expect(
      goalHeadline({ ...goal, status: "exhausted", endedBy: "cost" }, false)
    ).toBe("Goal ran out of budget (cost)");
    expect(goalHeadline({ ...goal, status: "completed" }, false)).toBe(
      "Goal completed"
    );
  });
});
