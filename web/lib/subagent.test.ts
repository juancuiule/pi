import { describe, expect, it } from "vitest";

import { subagentIdOf } from "./subagent";

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
