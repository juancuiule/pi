import { describe, expect, it } from "vitest";

import { parseConversationId } from "./conversation-id";

describe(parseConversationId, () => {
  it("parses an integer id", () => {
    expect(parseConversationId("42")).toBe(42);
    expect(parseConversationId("0")).toBe(0);
  });

  it("rejects a missing or non-integer value", () => {
    expect(parseConversationId(null)).toBeUndefined();
    expect(parseConversationId("abc")).toBeUndefined();
    expect(parseConversationId("1.5")).toBeUndefined();
    expect(parseConversationId("1px")).toBeUndefined();
  });
});
