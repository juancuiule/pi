// The agent's todo list (src/tools/todos.ts): `update_todos` arguments and `details.todos`, its counts, and the line
// the plan strip shows. Arguments may be partial while a call streams, so parsing never throws.
import type { Todo } from "effect-pi/api";

const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** The valid items of an `update_todos` argument or result's `details`; `[]` for anything else. */
export const todosOf = (value: unknown): readonly Todo[] => {
  const list =
    typeof value === "object" && value !== null && "todos" in value
      ? (value as { todos: unknown }).todos
      : undefined;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item: unknown): Todo[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const { content, status } = item as Record<string, unknown>;
    return typeof content === "string" &&
      content !== "" &&
      typeof status === "string" &&
      STATUSES.has(status)
      ? [{ content, status: status as Todo["status"] }]
      : [];
  });
};

export interface TodoProgress {
  readonly completed: number;
  readonly total: number;
  /** The item in progress, else the first pending one; absent once all are done. */
  readonly current: Todo | undefined;
}

export const todoProgress = (todos: readonly Todo[]): TodoProgress => ({
  completed: todos.filter((todo) => todo.status === "completed").length,
  total: todos.length,
  current:
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending"),
});

/** "2/5 · Compute monthly totals", "5/5 done", or "" for an empty list. */
export const todoLine = (todos: readonly Todo[]): string => {
  const { completed, total, current } = todoProgress(todos);
  if (total === 0) {
    return "";
  }
  return current === undefined
    ? `${completed}/${total} done`
    : `${completed}/${total} · ${current.content}`;
};
