import type { Context } from "@earendil-works/chord";
// The agent's todo list (#92): one whole-list-replace tool, `update_todos`, writing a per-conversation pi-durable
// document, and a `todos` prompt section that shows the list before every request while some item is still open.
// A subagent writes its own conversation's list (the doc is keyed by `api.conversationId`); a finished list costs
// nothing, because the section returns nothing and the null delta removes it.
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentReader,
  Extension,
} from "@earendil-works/pi-durable";

export const UPDATE_TODOS = "update_todos";

/** Schema limits instead of a size cap: pi-durable refuses bad arguments with `invalid_arguments` before `execute`. */
export const MAX_TODOS = 30;
export const MAX_TODO_CHARS = 200;

const TodoSchema = Type.Object({
  content: Type.String({
    minLength: 1,
    maxLength: MAX_TODO_CHARS,
    description: "The step, in one imperative line",
  }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
});

const Parameters = Type.Object({
  todos: Type.Array(TodoSchema, {
    maxItems: MAX_TODOS,
    description: "The whole list, in order",
  }),
});

export type Todo = Static<typeof TodoSchema>;
export type TodoStatus = Todo["status"];

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type TodosState = { todos: Todo[] };

/**
 * Rewindable with `asOf`, so a fork at an earlier entry sees the list as it was then; a checkpoint every 31 deltas
 * bounds the replay tail a rewindable doc would otherwise grow without limit.
 */
export const TodosDoc = defineDoc<TodosState>({
  kind: "app.todos",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
  initial: () => ({ todos: [] }),
});

/** A conversation's todo list, empty when it never wrote one. */
export const readTodos = async (
  read: Pick<DocumentReader, "snapshot">,
  id: ConversationId,
  context: Context
): Promise<Todo[]> => {
  const doc = await read.snapshot(TodosDoc, id, context);
  return doc?.todos ?? [];
};

export interface TodoCounts {
  readonly total: number;
  readonly completed: number;
  readonly inProgress: number;
  readonly pending: number;
}

export const todoCounts = (todos: readonly Todo[]): TodoCounts => ({
  total: todos.length,
  completed: todos.filter((todo) => todo.status === "completed").length,
  inProgress: todos.filter((todo) => todo.status === "in_progress").length,
  pending: todos.filter((todo) => todo.status === "pending").length,
});

/** Some item is not completed yet; an empty list has nothing open. */
export const hasOpenTodos = (todos: readonly Todo[]): boolean =>
  todos.some((todo) => todo.status !== "completed");

/** Every item is completed, and there is at least one. */
export const allTodosDone = (todos: readonly Todo[]): boolean =>
  todos.length > 0 && !hasOpenTodos(todos);

/** The item to work on: the first in progress, else the first pending. */
export const currentTodo = (todos: readonly Todo[]): Todo | undefined =>
  todos.find((todo) => todo.status === "in_progress") ??
  todos.find((todo) => todo.status === "pending");

/** The tool's one-line result: the section already shows the list, so the result only counts it. */
export const countsText = (todos: readonly Todo[]): string => {
  const counts = todoCounts(todos);
  if (counts.total === 0) {
    return "Todo list cleared.";
  }
  return `Todo list updated: ${counts.completed} completed, ${counts.inProgress} in progress, ${counts.pending} pending.`;
};

const MARK: Record<TodoStatus, string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

/** The section's body: one compact line per item; `undefined` (no section) once nothing is open. */
export const renderTodos = (todos: readonly Todo[]): string | undefined =>
  hasOpenTodos(todos)
    ? [
        "Your todo list. Update it with update_todos; the person sees it.",
        ...todos.map((todo) => `${MARK[todo.status]} ${todo.content}`),
      ].join("\n")
    : undefined;

export const todosExtension = (): Extension =>
  defineExtension({
    name: "todos",
    tools: [
      defineTool({
        name: UPDATE_TODOS,
        description: [
          "Replace your todo list with `todos`: the whole list, in order. Items you leave out are removed.",
          "Use it for work with three or more steps, or when the person asks for several things.",
          "Write the list before you start, keep one item in_progress, mark each item completed as soon as it is done (not in a batch at the end), and add steps as you find them.",
          "Skip it for one-step requests and plain questions.",
          "The list is shown to you in <todos> before every request and to the person in the console, and it survives pauses and restarts.",
        ].join(" "),
        parameters: Parameters,
        // A whole-list replace is idempotent: a rerun after a crash writes the same list again.
        replay: "safe",
        execute: async ({ todos }, api, context) => {
          // Copied out: the doc stores plain JSON, not the validated arguments.
          const list = todos.map((todo) => ({
            content: todo.content,
            status: todo.status,
          }));
          await api.commit(async (tx) => {
            const doc = await tx.doc(TodosDoc, api.conversationId);
            doc.todos = list;
          }, context);
          return {
            content: [{ type: "text", text: countsText(list) }],
            details: { todos: list },
          };
        },
      }),
    ],
    sections: [
      section("todos", async (input, context) => {
        const doc = await input.read.snapshot(
          TodosDoc,
          input.conversationId,
          context
        );
        return renderTodos(doc?.todos ?? []);
      }),
    ],
  });
