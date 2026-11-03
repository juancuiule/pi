"use client";

// Under the conversation header: the goal (`/goal`) with its progress, budget used and its controls, then the
// agent's todo list as a plan strip that expands into the checklist. Both read their endpoints, polled while a Run
// goes, so they stay right after a compaction hides the last `update_todos` call.
import type { ConversationSummary } from "effect-pi/api";
import { ChevronDown, ListTodo, Target, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { goalHeadline, goalProgress } from "@/lib/goal";
import { useGoal, useGoalAction, useTodos } from "@/lib/queries";
import { todoLine } from "@/lib/todos";
import { cn } from "@/lib/utils";

import { TodoList } from "./todo-list";

const GoalRow = ({
  conversation,
  running,
}: {
  readonly conversation: ConversationSummary;
  readonly running: boolean;
}) => {
  const { data } = useGoal(conversation.id, running);
  const act = useGoalAction();
  // An ended goal can be put away; a new goal (another start time) shows again.
  const [dismissed, setDismissed] = useState<number>();
  const goal = data?.goal;
  if (goal === undefined || dismissed === goal.startedAt) {
    return null;
  }
  const active = goal.status === "active";
  const run = (action: "cancel" | "continue") =>
    act.mutate(
      { id: conversation.id, action },
      { onError: (error) => toast.error(error.message) }
    );
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      <Target
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          active ? "text-foreground" : "text-muted-foreground"
        )}
        strokeWidth={1.5}
      />
      <span className="font-medium">{goalHeadline(goal, running)}</span>
      <span
        className="text-muted-foreground min-w-0 flex-1 truncate"
        title={goal.objective}
      >
        {goal.objective}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {goalProgress(goal)}
      </span>
      {active && !running && conversation.status !== "archived" ? (
        <Button
          variant="outline"
          size="xs"
          disabled={act.isPending}
          onClick={() => run("continue")}
        >
          Continue
        </Button>
      ) : null}
      {active ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={act.isPending}
          onClick={() => run("cancel")}
        >
          Cancel goal
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Hide the goal"
          onClick={() => setDismissed(goal.startedAt)}
        >
          <X />
        </Button>
      )}
      {goal.summary === undefined ? null : (
        <p className="text-muted-foreground basis-full">{goal.summary}</p>
      )}
    </div>
  );
};

const PlanStrip = ({
  conversation,
  running,
}: {
  readonly conversation: ConversationSummary;
  readonly running: boolean;
}) => {
  const { data } = useTodos(conversation.id, running);
  const [open, setOpen] = useState(false);
  const todos = data?.todos ?? [];
  if (todos.length === 0) {
    return null;
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/plan text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-1.5 text-left text-xs"
      >
        <ListTodo aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {todoLine(todos)}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-180"
          )}
          strokeWidth={1.5}
        />
      </button>
      {open ? (
        <div className="pt-2 pl-5">
          <TodoList todos={todos} />
        </div>
      ) : null}
    </div>
  );
};

export const GoalBanner = ({
  conversation,
  running,
}: {
  readonly conversation: ConversationSummary;
  readonly running: boolean;
}) => (
  <div className="flex flex-col gap-1.5 border-b px-3 py-1.5 empty:hidden md:px-4">
    <GoalRow conversation={conversation} running={running} />
    <PlanStrip conversation={conversation} running={running} />
  </div>
);
