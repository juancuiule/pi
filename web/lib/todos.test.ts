import { describe, expect, it } from "vitest";

import { todoLine, todoProgress, todosOf } from "./todos";

const todos = [
  { content: "Read", status: "completed" },
  { content: "Compute", status: "in_progress" },
  { content: "Write", status: "pending" },
] as const;

describe(todosOf, () => {
  it("keeps the valid items of arguments or details", () => {
    expect(
      todosOf({
        todos: [
          ...todos,
          { content: "", status: "pending" },
          { status: "x" },
          3,
        ],
      })
    ).toStrictEqual(todos);
    expect(todosOf("")).toStrictEqual([]);
    expect(todosOf({ todos: "nope" })).toStrictEqual([]);
  });
});

describe(todoLine, () => {
  it("shows the count and the current item, or done", () => {
    expect(todoLine(todos)).toBe("1/3 · Compute");
    expect(
      todoLine(todos.map((todo) => ({ ...todo, status: "completed" as const })))
    ).toBe("3/3 done");
    expect(todoLine([])).toBe("");
    expect(todoProgress([todos[2]]).current?.content).toBe("Write");
  });
});
