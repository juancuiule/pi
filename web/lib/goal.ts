// Goal mode in the console (src/goal/format.ts): the `<goal>` block a `/goal` message became, the automatic
// `<goal_continuation>` messages, and the banner's lines.
import type { GoalInfo } from "effect-pi/api";

import { formatCost } from "./format";

const OPEN = "<goal>\n";
const CLOSE = "\n</goal>";

/** The objective of a message that started a goal; `undefined` for any other text. */
export const goalObjectiveOf = (text: string): string | undefined =>
  text.startsWith(OPEN) && text.endsWith(CLOSE)
    ? text.slice(OPEN.length, -CLOSE.length)
    : undefined;

// oxlint-disable-next-line prefer-named-capture-group -- web targets ES2017, without named groups
const CONTINUATION = /^<goal_continuation turn="(\d+)" of="(\d+)">\n/u;

/** An automatic continuation's turn and the goal's turn budget; `undefined` for a person's message. */
export const continuationOf = (
  text: string
): { readonly turn: number; readonly of: number } | undefined => {
  const match = CONTINUATION.exec(text);
  return match === null
    ? undefined
    : { turn: Number(match[1]), of: Number(match[2]) };
};

const ENDED: Record<Exclude<GoalInfo["status"], "active">, string> = {
  completed: "Goal completed",
  blocked: "Goal blocked",
  stopped: "Goal stopped",
  exhausted: "Goal ran out of budget",
};

/** The banner's title: what the goal is doing, or why it ended. */
export const goalHeadline = (goal: GoalInfo, running: boolean): string => {
  if (goal.status !== "active") {
    if (goal.status === "exhausted") {
      return goal.endedBy === "cost"
        ? "Goal ran out of budget (cost)"
        : "Goal ran out of budget (turns)";
    }
    return ENDED[goal.status];
  }
  return running ? "Working toward the goal" : "Goal waiting to continue";
};

/** "2/5 todos · turn 3 of 20 · $0.12 of $5.00". */
export const goalProgress = (goal: GoalInfo): string => {
  const parts: string[] = [];
  if (goal.todos.total > 0) {
    parts.push(`${goal.todos.completed}/${goal.todos.total} todos`);
  }
  parts.push(`turn ${goal.turns} of ${goal.maxTurns}`);
  const spent = formatCost(goal.costUsd);
  parts.push(
    goal.maxCostUsd > 0 ? `${spent} of ${formatCost(goal.maxCostUsd)}` : spent
  );
  return parts.join(" · ");
};
