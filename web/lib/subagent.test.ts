import type { EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";
import {
  activeSubagents,
  subagentIdFor,
  subagentIdOf,
  subagentsInFlight,
} from "./subagent";

describe(subagentIdOf, () => {
  it("reads a numeric conversationId", () => {
    expect(subagentIdOf({ conversationId: 7 })).toBe(7);
  });

  it("ignores anything else", () => {
    expect(subagentIdOf()).toBeUndefined();
    expect(subagentIdOf(null)).toBeUndefined();
    expect(subagentIdOf("7")).toBeUndefined();
    expect(subagentIdOf({})).toBeUndefined();
    expect(subagentIdOf({ conversationId: "7" })).toBeUndefined();
  });
});

describe(subagentIdFor, () => {
  const live = {
    ...initialState,
    tools: {
      c1: { status: "running", output: "", details: { conversationId: 3 } },
    },
  } as unknown as ConversationState;
  const committed = {
    ...initialState,
    entries: [
      {
        id: 1,
        conversationId: 1,
        kind: "test",
        model: [
          {
            role: "toolResult",
            toolCallId: "c1",
            content: [],
            details: { conversationId: 9 },
          },
        ],
      },
    ],
  } as unknown as ConversationState;

  it("prefers the live slot's details", () => {
    expect(subagentIdFor(live, "c1")).toBe(3);
  });

  it("falls back to the committed tool result", () => {
    expect(subagentIdFor(committed, "c1")).toBe(9);
  });

  it("is undefined when neither has one", () => {
    expect(subagentIdFor(initialState, "c1")).toBeUndefined();
  });
});

const withTools = (tools: Record<string, unknown>) =>
  ({ ...initialState, tools }) as unknown as ConversationState;

describe(activeSubagents, () => {
  it("counts task calls still in flight", () => {
    expect(
      activeSubagents(
        withTools({
          c1: { name: "task", status: "running" },
          c2: { name: "task", status: "done" },
          c3: { name: "task", status: "running" },
          c4: { name: "bash", status: "running" },
        })
      )
    ).toBe(2);
  });

  it("is zero with no task calls", () => {
    expect(activeSubagents(initialState)).toBe(0);
  });
});

describe(subagentsInFlight, () => {
  const calls = {
    id: 1,
    conversationId: 1,
    kind: "message",
    model: [
      {
        role: "assistant",
        content: ["running", "finished", "starting", "shell"].map((id) => ({
          type: "toolCall",
          id,
          name: id === "shell" ? "bash" : "task",
          arguments: {},
        })),
      },
    ],
  } as unknown as EntryRecord;
  const state = {
    ...initialState,
    entries: [calls],
    tools: {
      running: {
        name: "task",
        status: "running",
        details: { conversationId: 7 },
      },
      finished: {
        name: "task",
        status: "done",
        details: { conversationId: 8 },
      },
      starting: { name: "task", status: "running", details: undefined },
      shell: {
        name: "bash",
        status: "running",
        details: { conversationId: 9 },
      },
    },
  } as unknown as ConversationState;

  it("lists the child of each running task call, dropping finished ones and those without an id yet", () => {
    expect(subagentsInFlight([calls], state)).toStrictEqual([7]);
  });
});
