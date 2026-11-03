// `update_todos`: the whole list replaces the doc, the `todos` section shows it while an item is open, and each
// conversation (a subagent's too) keeps its own list across a restart.
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
  openSeat,
} from "../testing/faux.ts";
import { alice } from "../testing/users.ts";
import { countsText, MAX_TODO_CHARS, MAX_TODOS, renderTodos } from "./todos.ts";
import type { Todo } from "./todos.ts";

const plan: Todo[] = [
  { content: "Read the attached CSV", status: "completed" },
  { content: "Compute monthly totals", status: "in_progress" },
  { content: "Write the summary", status: "pending" },
];
const done: Todo[] = plan.map((todo) => ({ ...todo, status: "completed" }));

describe(renderTodos, () => {
  it("renders one line per item while one is open, and nothing once all are done", () => {
    expect(renderTodos(plan)).toBe(
      [
        "Your todo list. Update it with update_todos; the person sees it.",
        "[x] Read the attached CSV",
        "[>] Compute monthly totals",
        "[ ] Write the summary",
      ].join("\n")
    );
    expect(renderTodos(done)).toBeUndefined();
    expect(renderTodos([])).toBeUndefined();
  });

  it("counts the list for the tool result", () => {
    expect(countsText(plan)).toBe(
      "Todo list updated: 1 completed, 1 in progress, 1 pending."
    );
    expect(countsText([])).toBe("Todo list cleared.");
  });
});

describe("update_todos", () => {
  it("writes the doc and shows the list in the next request's todos section, at Level none", async () => {
    const { layer } = fauxAgents([
      callTool("update_todos", { todos: plan }),
      echoToolResult,
      offered,
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          const first = yield* seat.ask("plan the report");
          const second = offeredIn(yield* seat.ask("what next?"));
          return { first, second, todos: yield* agents.todos(seat.id) };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.first).toBe(countsText(plan));
    expect(result.second.tools).toContain("update_todos");
    expect(result.second.system).toContain("[>] Compute monthly totals");
    expect(result.todos).toStrictEqual(plan);
  });

  it("removes the section once every item is completed", async () => {
    const { layer } = fauxAgents([
      callTool("update_todos", { todos: plan }),
      echoToolResult,
      fauxAssistantMessage(
        [
          // A second call id: the first is taken.
          {
            type: "toolCall",
            id: "call-2",
            name: "update_todos",
            arguments: { todos: done },
          },
        ],
        { stopReason: "toolUse" }
      ),
      echoToolResult,
      offered,
    ]);
    const system = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seat = yield* openSeat();
          yield* seat.ask("plan");
          yield* seat.ask("finish");
          return offeredIn(yield* seat.ask("anything left?")).system;
        })
      ).pipe(Effect.provide(layer))
    );
    expect(system).toContain('"todos":null');
  });

  it("refuses more than the schema allows", async () => {
    const tooMany = Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      content: `step ${index}`,
      status: "pending",
    }));
    const { layer } = fauxAgents([
      callTool("update_todos", { todos: tooMany }),
      echoToolResult,
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "call-long",
            name: "update_todos",
            arguments: {
              todos: [
                { content: "x".repeat(MAX_TODO_CHARS + 1), status: "pending" },
              ],
            },
          },
        ],
        { stopReason: "toolUse" }
      ),
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const seat = yield* openSeat();
          const many = yield* seat.ask("plan a lot");
          const long = yield* seat.ask("plan a long step");
          return { many, long, todos: yield* agents.todos(seat.id) };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.many).toMatch(/^error: /u);
    expect(result.long).toMatch(/^error: /u);
    expect(result.todos).toStrictEqual([]);
  });

  it("gives a subagent its own list, leaving the parent's alone", async () => {
    const { layer } = fauxAgents([
      callTool("task", { prompt: "Plan the research." }),
      callTool("update_todos", { todos: plan }),
      echoToolResult,
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const parent = yield* agents.create({
            owner: alice.id,
            prompt: "",
            title: "",
            level: "none",
            createdAt: Date.now(),
          });
          const seat = yield* agents.open(parent);
          yield* seat.ask("delegate the plan");
          // The `task` call's result names the child it created.
          const entries = yield* Stream.runCollect(
            yield* agents.entries(parent)
          );
          const child = entries
            .flatMap((entry) => entry.model ?? [])
            .flatMap((message) =>
              message.role === "toolResult" && message.toolName === "task"
                ? [
                    (message.details as { conversationId: number })
                      .conversationId,
                  ]
                : []
            )[0] as ConversationId;
          return {
            parent: yield* agents.todos(parent),
            child: yield* agents.todos(child),
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.parent).toStrictEqual([]);
    expect(result.child).toStrictEqual(plan);
  });
});
