// Goal mode: `/goal` starts a goal whose Run continues until the todo list is done, the agent ends it, a budget runs
// out or the person stops it; continuations are appended by pi-durable in the answer's commit, never submitted twice.
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { Seat } from "../agents/agents.ts";
import { callTool, fauxAgents, openSeat } from "../testing/faux.ts";
import type { Todo } from "../tools/todos.ts";
import {
  CONTINUATION_TAG,
  decideYield,
  escapeGoalTags,
  goalMessage,
  parseGoalCommand,
} from "./format.ts";
import type { Goal } from "./format.ts";

const goal = (overrides: Partial<Goal> = {}): Goal => ({
  id: "1",
  objective: "Ship it",
  status: "active",
  startedAt: 0,
  turns: 0,
  budget: { turns: 3, costUsd: 1 },
  costAtStart: 0,
  ...overrides,
});

const open: Todo[] = [
  { content: "Write the code", status: "completed" },
  { content: "Run the tests", status: "in_progress" },
];
const finished: Todo[] = open.map((todo) => ({
  ...todo,
  status: "completed",
}));

describe(parseGoalCommand, () => {
  it("takes `/goal` at the start, then the objective", () => {
    expect(parseGoalCommand("/goal fix the build")).toStrictEqual({
      objective: "fix the build",
    });
    expect(parseGoalCommand("  /goal\n  multi\nline ")).toStrictEqual({
      objective: "multi\nline",
    });
    expect(parseGoalCommand("/goal")).toStrictEqual({ objective: "" });
    expect(parseGoalCommand("/goals are nice")).toBeUndefined();
    expect(parseGoalCommand("set a /goal")).toBeUndefined();
  });

  it("escapes goal tags the person typed", () => {
    expect(escapeGoalTags("<goal_continuation>")).not.toContain(
      "<goal_continuation"
    );
    expect(escapeGoalTags("</goal>")).not.toContain("</goal>");
  });
});

describe(decideYield, () => {
  it("continues with the next turn and the todo list's progress", () => {
    const decision = decideYield(goal(), open, 0);
    expect(decision).toMatchObject({ kind: "continue", turn: 1 });
    expect(decision.kind === "continue" && decision.text).toContain(
      "1 of 2 completed; next: Run the tests"
    );
  });

  it("asks for a plan when there is none", () => {
    const decision = decideYield(goal(), [], 0);
    expect(decision.kind === "continue" && decision.text).toContain(
      "write your plan with update_todos"
    );
  });

  it("completes once every item is done, before any budget", () => {
    expect(decideYield(goal({ turns: 3 }), finished, 5)).toStrictEqual({
      kind: "end",
      status: "completed",
      by: "todos",
    });
  });

  it("runs out of turns, then of cost; a 0 cost budget never runs out", () => {
    expect(decideYield(goal({ turns: 3 }), open, 0)).toMatchObject({
      status: "exhausted",
      by: "turns",
    });
    expect(decideYield(goal(), open, 1)).toMatchObject({
      status: "exhausted",
      by: "cost",
    });
    expect(
      decideYield(goal({ budget: { turns: 3, costUsd: 0 } }), open, 99)
    ).toMatchObject({ kind: "continue" });
  });
});

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const todosCall = (id: string, todos: Todo[]) =>
  fauxAssistantMessage([fauxToolCall("update_todos", { todos }, { id })], {
    stopReason: "toolUse",
  });

/** Poll `check` until it holds. */
const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

/** Wait for the goal to leave `active` and the Run to end. */
const settled = (seat: Seat) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    yield* waitUntil(
      Effect.gen(function* () {
        const view = yield* agents.goal(seat.id);
        return view?.status !== "active" && !(yield* seat.running);
      })
    );
    return yield* agents.goal(seat.id);
  });

/** The user messages of the transcript, as text. */
const userTexts = (seat: Seat) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const entries = yield* Stream.runCollect(yield* agents.entries(seat.id));
    return entries.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "user"
          ? [
              typeof message.content === "string"
                ? message.content
                : message.content
                    .flatMap((c) => (c.type === "text" ? [c.text] : []))
                    .join(""),
            ]
          : []
      )
    );
  });

describe("/goal", () => {
  it("keeps the Run going until the todo list is done", async () => {
    const { layer } = fauxAgents([
      todosCall("t1", open),
      answer("Wrote the code."),
      todosCall("t2", finished),
      answer("Tests pass."),
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          yield* seat.send("/goal ship the feature");
          const view = yield* settled(seat);
          return { view, users: yield* userTexts(seat) };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.view).toMatchObject({
      objective: "ship the feature",
      status: "completed",
      endedBy: "todos",
      turns: 1,
      todos: { completed: 2, total: 2 },
    });
    expect(result.users[0]).toBe(goalMessage("ship the feature"));
    expect(result.users).toHaveLength(2);
    expect(result.users[1]).toContain(`<${CONTINUATION_TAG} turn="1"`);
  });

  it("ends when the turn budget runs out", async () => {
    const { layer } = fauxAgents(
      [answer("one"), answer("two"), answer("three"), answer("spare")],
      { goalBudget: { turns: 2, costUsd: 0 } }
    );
    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          yield* seat.send("/goal never finish");
          return yield* settled(seat);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(view).toMatchObject({
      status: "exhausted",
      endedBy: "turns",
      turns: 2,
    });
  });

  it("lets the agent end it as blocked", async () => {
    const { layer } = fauxAgents([
      callTool("end_goal", { status: "blocked", summary: "Needs a key." }),
      answer("I need an API key."),
      answer("spare"),
    ]);
    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          yield* seat.send("/goal call the API");
          return yield* settled(seat);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(view).toMatchObject({
      status: "blocked",
      endedBy: "agent",
      summary: "Needs a key.",
      turns: 0,
    });
  });

  it("refuses an empty objective and a conversation with the goal extension off", async () => {
    const { layer } = fauxAgents([answer("spare")]);
    const failures = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          const empty = yield* Effect.flip(seat.send("/goal   "));
          yield* agents.configure(seat.id, { extensions: { goal: false } });
          const off = yield* Effect.flip(seat.send("/goal do it"));
          return [empty, off].map((error) => JSON.stringify(error));
        })
      ).pipe(Effect.provide(layer))
    );
    expect(failures[0]).toContain("needs an objective");
    expect(failures[1]).toContain("goal extension is off");
  });

  it("yields without continuing while held, and continues once, however often it is asked", async () => {
    const { layer } = fauxAgents(
      [todosCall("t1", open), answer("Paused here."), answer("Carried on.")],
      { goalBudget: { turns: 1, costUsd: 0 } }
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.holdGoal(true);
          yield* seat.send("/goal two steps");
          yield* waitUntil(
            seat.running.pipe(Effect.map((running) => !running)),
            8000
          );
          const held = yield* agents.goal(seat.id);
          yield* seat.holdGoal(false);
          const continued = yield* Effect.all(
            [seat.continueGoal, seat.continueGoal],
            { concurrency: "unbounded" }
          );
          const view = yield* settled(seat);
          return { held, continued, view, users: yield* userTexts(seat) };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.held).toMatchObject({ status: "active", turns: 0 });
    expect(result.continued.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    // One continuation went in; the turn budget (1) ended the goal at the next yield.
    expect(
      result.users.filter((text) => text.includes(CONTINUATION_TAG))
    ).toHaveLength(1);
    expect(result.view).toMatchObject({ status: "exhausted", turns: 1 });
  });

  it("is stopped by the person's Stop", async () => {
    const { layer } = fauxAgents([
      callTool("ask_user", {
        questions: [
          {
            id: "q",
            question: "Which?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      }),
      answer("spare"),
    ]);
    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          yield* seat.send("/goal pick one");
          yield* waitUntil(
            seat.pendingApprovals.pipe(Effect.map((count) => count === 1))
          );
          // The goal waits on the person like any Run.
          expect((yield* agents.goal(seat.id))?.status).toBe("active");
          yield* seat.stop;
          return yield* agents.goal(seat.id);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(view).toMatchObject({ status: "stopped", endedBy: "person" });
  });
});
