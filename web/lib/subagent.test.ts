import { describe, expect, it } from "vitest";

import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";
import { subagentIdFor, subagentIdOf } from "./subagent";

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
