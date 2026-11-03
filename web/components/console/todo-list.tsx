"use client";

// The agent's todo list as a checklist: in an `update_todos` card and in the plan strip under the header.
import type { Todo } from "effect-pi/api";
import { Circle, CircleCheck, CircleDot } from "lucide-react";

import { cn } from "@/lib/utils";

const ICON = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const;

const LABEL = {
  completed: "Completed",
  in_progress: "In progress",
  pending: "Pending",
} as const;

export const TodoList = ({ todos }: { readonly todos: readonly Todo[] }) => (
  <ul className="flex flex-col gap-1">
    {todos.map((todo, position) => {
      const Icon = ICON[todo.status];
      return (
        // oxlint-disable-next-line no-array-index-key -- items have no id; the list is replaced whole
        <li key={position} className="flex items-start gap-2 text-xs">
          <Icon
            aria-label={LABEL[todo.status]}
            className={cn(
              "mt-px size-3.5 shrink-0",
              todo.status === "in_progress"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
            strokeWidth={1.5}
          />
          <span
            className={cn(
              "min-w-0 break-words",
              todo.status === "completed" &&
                "text-muted-foreground line-through",
              todo.status === "in_progress" && "text-foreground font-medium"
            )}
          >
            {todo.content}
          </span>
        </li>
      );
    })}
  </ul>
);
