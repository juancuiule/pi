// The pure part of goal mode (`/goal <objective>`, see docs/adr/0010-goal-mode-continues-the-run.md): parsing the
// command, the messages the model reads, the prompt section, and the decision taken each time the agent yields.
import type { Todo } from "../tools/todos.ts";
import { allTodosDone, currentTodo, todoCounts } from "../tools/todos.ts";

export const GOAL_COMMAND = "/goal";

/** Longest objective; a goal is one line or a short paragraph, not a document. */
export const MAX_OBJECTIVE_CHARS = 2000;

export type GoalStatus =
  | "active"
  | "completed"
  | "blocked"
  | "stopped"
  | "exhausted";

/** Who or what ended a goal: the agent (`end_goal`), its finished todo list, a budget, or the person. */
export type GoalEnd = "agent" | "todos" | "turns" | "cost" | "person";

// Types, not interfaces: they are stored in a pi-durable document, which must hold JSON types.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type GoalBudget = {
  /** Automatic continuations allowed. */
  turns: number;
  /** USD the conversation and its subagents may spend on the goal; 0 means no limit. */
  costUsd: number;
};

// oxlint-disable-next-line typescript/consistent-type-definitions
export type Goal = {
  /** Unique within the conversation; continuation request ids carry it. */
  id: string;
  objective: string;
  status: GoalStatus;
  startedAt: number;
  endedAt?: number;
  endedBy?: GoalEnd;
  /** The agent's `end_goal` summary. */
  summary?: string;
  /** Automatic continuations used so far. */
  turns: number;
  budget: GoalBudget;
  /** The conversation tree's total cost when the goal started; the budget counts from here. */
  costAtStart: number;
};

/** `prompt` starts a goal: `/goal` then the objective. `undefined` for any other prompt. */
export const parseGoalCommand = (
  prompt: string
): { readonly objective: string } | undefined => {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith(GOAL_COMMAND)) {
    return;
  }
  const rest = trimmed.slice(GOAL_COMMAND.length);
  // `/goals`, `/goalie`: not the command.
  if (rest !== "" && !/^\s/u.test(rest)) {
    return;
  }
  return { objective: rest.trim() };
};

/** What the person typed can never pass for a block the server writes. */
export const escapeGoalTags = (text: string): string =>
  text.replaceAll(/<(?<slash>\/?)goal/giu, "<$<slash>​goal");

export const GOAL_OPEN = "<goal>\n";
export const GOAL_CLOSE = "\n</goal>";

/** The message that starts a goal: the objective, in a block the console shows as a goal. */
export const goalMessage = (objective: string): string =>
  `${GOAL_OPEN}${objective}${GOAL_CLOSE}`;

const usd = (value: number) => `$${value.toFixed(2)}`;

export const budgetText = (budget: GoalBudget): string =>
  budget.costUsd > 0
    ? `${budget.turns} automatic turns or ${usd(budget.costUsd)}, whichever comes first`
    : `${budget.turns} automatic turns`;

/** The `goal` section while a goal is active; stable for the goal's life, so it costs one system delta. */
export const goalSection = (goal: Goal): string =>
  [
    "The person set you a goal. The server keeps you working on it turn after turn, without waiting for them:",
    goal.objective,
    "",
    "Start by writing your plan with update_todos, then work through it, marking each item completed as soon as it is done.",
    `The goal ends when every todo item is completed, when you call end_goal, or when its budget runs out (${budgetText(goal.budget)}).`,
    "Do not stop to report progress or ask whether to continue. If you need a decision from the person, use ask_user. If you cannot go on, call end_goal with status blocked and say why; when the goal is met, call end_goal with status done.",
  ].join("\n");

export const CONTINUATION_TAG = "goal_continuation";

/** The automatic message that continues a goal; the console shows it as automatic, not as the person's. */
export const continuationMessage = (
  goal: Pick<Goal, "budget">,
  turn: number,
  todos: readonly Todo[]
): string => {
  const counts = todoCounts(todos);
  const next = currentTodo(todos);
  const plan =
    counts.total === 0
      ? "You have no todo list yet: write your plan with update_todos, then work through it."
      : `Todo list: ${counts.completed} of ${counts.total} completed${next === undefined ? "" : `; next: ${next.content}`}.`;
  return [
    `<${CONTINUATION_TAG} turn="${turn}" of="${goal.budget.turns}">`,
    `Keep working toward the goal. ${plan}`,
    "When every item is completed, give your final answer. If you cannot go on without the person, use ask_user, or call end_goal with status blocked.",
    `</${CONTINUATION_TAG}>`,
  ].join("\n");
};

export type YieldDecision =
  | { readonly kind: "continue"; readonly turn: number; readonly text: string }
  | {
      readonly kind: "end";
      readonly status: "completed" | "exhausted";
      readonly by: GoalEnd;
    };

/**
 * What happens when the agent yields (gives a final answer) while `goal` is active: it ends, because the todo list
 * is done or a budget ran out, or it continues with another automatic turn. `costUsed` is the conversation tree's
 * spend since the goal started.
 */
export const decideYield = (
  goal: Goal,
  todos: readonly Todo[],
  costUsed: number
): YieldDecision => {
  if (allTodosDone(todos)) {
    return { kind: "end", status: "completed", by: "todos" };
  }
  if (goal.turns >= goal.budget.turns) {
    return { kind: "end", status: "exhausted", by: "turns" };
  }
  if (goal.budget.costUsd > 0 && costUsed >= goal.budget.costUsd) {
    return { kind: "end", status: "exhausted", by: "cost" };
  }
  const turn = goal.turns + 1;
  return {
    kind: "continue",
    turn,
    text: continuationMessage(goal, turn, todos),
  };
};

/** A goal as the console shows it: its state, its budget and what it used, and its todo list's progress. */
export interface GoalView {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly endedBy?: GoalEnd;
  readonly summary?: string;
  readonly turns: number;
  readonly maxTurns: number;
  /** USD spent on the goal so far, by the conversation and its subagents. */
  readonly costUsd: number;
  /** 0 when the goal has no cost limit. */
  readonly maxCostUsd: number;
  readonly todos: { readonly completed: number; readonly total: number };
}

/** `cost` is the conversation tree's total now; the view counts from the goal's start. */
export const goalView = (
  goal: Goal,
  todos: readonly Todo[],
  cost: number
): GoalView => {
  const counts = todoCounts(todos);
  return {
    objective: goal.objective,
    status: goal.status,
    startedAt: goal.startedAt,
    ...(goal.endedAt === undefined ? {} : { endedAt: goal.endedAt }),
    ...(goal.endedBy === undefined ? {} : { endedBy: goal.endedBy }),
    ...(goal.summary === undefined ? {} : { summary: goal.summary }),
    turns: goal.turns,
    maxTurns: goal.budget.turns,
    costUsd: Math.max(0, cost - goal.costAtStart),
    maxCostUsd: goal.budget.costUsd,
    todos: { completed: counts.completed, total: counts.total },
  };
};
