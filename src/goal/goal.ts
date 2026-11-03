// Goal mode: `/goal <objective>` keeps the agent working until its todo list is done, it calls `end_goal`, a budget
// runs out, or the person stops it. The goal is a per-conversation document; an `onYield` hook reads it each time the
// agent gives a final answer and, while the goal is active, continues the same Run with an automatic message.
// pi-durable appends that message in the commit that records the answer, so a crash or replay never submits it
// twice. Decisions: docs/adr/0010-goal-mode-continues-the-run.md.
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  Extension,
  Harness,
  UsageState,
} from "@earendil-works/pi-durable";

import { readTodos } from "../tools/todos.ts";
import { decideYield, goalSection } from "./format.ts";
import type { Goal, GoalBudget, YieldDecision } from "./format.ts";

export const END_GOAL = "end_goal";

/** What a goal may use unless the server is configured otherwise. */
export const DEFAULT_GOAL_BUDGET: GoalBudget = { turns: 20, costUsd: 5 };

// oxlint-disable-next-line typescript/consistent-type-definitions -- JSON doc fields must be types
export type GoalState = {
  /** The conversation's latest goal, active or ended; a new `/goal` replaces it. */
  goal?: Goal;
  /** Goals started so far; the next goal's id. */
  started: number;
};

export const GoalDoc = defineDoc<GoalState>({
  kind: "app.goal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ started: 0 }),
});

const usageCost = (state: Readonly<UsageState> | undefined): number => {
  let total = 0;
  for (const bucket of [state?.models ?? {}, state?.tools ?? {}]) {
    for (const usage of Object.values(bucket)) {
      total += usage.cost.total;
    }
  }
  return total;
};

/** The cost of a conversation and of every conversation its tasks created (its subagents), in USD. */
export const treeCost = async (
  harness: Pick<Harness, "commit" | "snapshot">,
  id: ConversationId,
  context: Context
): Promise<number> => {
  let total = usageCost(await harness.snapshot(UsageDoc, id, context));
  let cursor: Cursor | undefined;
  do {
    const after = cursor;
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by cursor
    const page = await harness.commit(
      (tx) => tx.scanConversations({ ownerConversationId: id }, 100, after),
      context
    );
    // oxlint-disable-next-line no-await-in-loop -- children are few, one level deep
    const costs = await Promise.all(
      page.items.map((child) => treeCost(harness, child.id, context))
    );
    total += costs.reduce((sum, cost) => sum + cost, 0);
    cursor = page.next;
  } while (cursor !== undefined);
  return total;
};

/** What the goal extension needs from the host. */
export interface GoalHost {
  /** The Harness; hooks and tools only run once it is open. */
  harness(): Harness;
  /** A Pause waits for this conversation's Run: its goal yields instead of continuing, and stays active. */
  held(id: ConversationId): boolean;
}

/** Apply a yield decision to the goal it was taken for. Idempotent, so a rerun of the hook writes the same. */
/** A conversation's latest goal, if it ever had one. */
export const readGoal = async (
  read: Pick<Harness, "snapshot">,
  id: ConversationId,
  context: Context
): Promise<Goal | undefined> => {
  const doc = await read.snapshot(GoalDoc, id, context);
  return doc?.goal;
};

export const applyDecision = (
  harness: Harness,
  id: ConversationId,
  goalId: string,
  decision: YieldDecision,
  context: Context,
  now: number
) =>
  harness.commit(async (tx) => {
    const doc = await tx.doc(GoalDoc, id);
    const { goal } = doc;
    if (goal?.id !== goalId || goal.status !== "active") {
      return;
    }
    if (decision.kind === "continue") {
      goal.turns = Math.max(goal.turns, decision.turn);
      return;
    }
    goal.status = decision.status;
    goal.endedBy = decision.by;
    goal.endedAt = now;
  }, context);

/** End an active goal as the person's choice (Stop, or the console's cancel); an ended goal stays as it is. */
export const stopGoal = (
  harness: Pick<Harness, "commit">,
  id: ConversationId,
  context: Context,
  now: number
) =>
  harness.commit(async (tx) => {
    const doc = await tx.doc(GoalDoc, id);
    const { goal } = doc;
    if (goal?.status !== "active") {
      return false;
    }
    goal.status = "stopped";
    goal.endedBy = "person";
    goal.endedAt = now;
    return true;
  }, context);

export const goalExtension = (host: GoalHost): Extension =>
  defineExtension({
    name: "goal",
    tools: [
      defineTool({
        name: END_GOAL,
        description:
          "End the goal the person set with /goal: status done when it is met, blocked when you cannot go on without them. Say what you did, or what blocks you, in summary. Only while a goal is active.",
        parameters: Type.Object({
          status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]),
          summary: Type.String({ minLength: 1, maxLength: 500 }),
        }),
        // Ending an ended goal changes nothing.
        replay: "safe",
        execute: async ({ status, summary }, api, context) => {
          const ended = await api.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, api.conversationId);
            const { goal } = doc;
            if (goal === undefined || goal.status !== "active") {
              return false;
            }
            goal.status = status === "done" ? "completed" : "blocked";
            goal.endedBy = "agent";
            goal.endedAt = Date.now();
            goal.summary = summary;
            return true;
          }, context);
          if (!ended) {
            return {
              content: [{ type: "text", text: "No goal is active." }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  status === "done"
                    ? "The goal is marked done. Give the person your final answer."
                    : "The goal is marked blocked. Tell the person what you need from them.",
              },
            ],
            details: { status },
          };
        },
      }),
    ],
    sections: [
      section("goal", async (input, context) => {
        const doc = await input.read.snapshot(
          GoalDoc,
          input.conversationId,
          context
        );
        return doc?.goal?.status === "active"
          ? goalSection(doc.goal)
          : undefined;
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) => {
          const doc = await api.snapshot(GoalDoc, api.conversationId, context);
          const goal = doc?.goal;
          if (goal?.status !== "active" || host.held(api.conversationId)) {
            return;
          }
          const harness = host.harness();
          const todos = await readTodos(api, api.conversationId, context);
          const cost = await treeCost(harness, api.conversationId, context);
          // The first decision of this generation wins: a rerun after a crash continues the same way, with the
          // same turn number, so the doc write below is idempotent.
          const decision = (await api.memo(
            `effect-pi.goal:${goal.id}`,
            decideYield(goal, todos, cost - goal.costAtStart) as JsonValue,
            context
          )) as YieldDecision;
          await applyDecision(
            harness,
            api.conversationId,
            goal.id,
            decision,
            context,
            Date.now()
          );
          return decision.kind === "continue"
            ? { continue: decision.text }
            : undefined;
        },
      }),
    ],
  });
