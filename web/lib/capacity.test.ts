import type { ConversationSummary } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { holdersOf, shortageText } from "./capacity";

const summary = (
  id: number,
  status: ConversationSummary["status"],
  pausing = false
): ConversationSummary => ({
  id,
  sandbox: "shell",
  title: `#${id}`,
  status,
  pausing,
  pendingApprovals: 0,
  createdAt: 0,
});

describe(holdersOf, () => {
  it("describes each holder the list knows, in the shortage's order", () => {
    expect(
      holdersOf({ resource: "shell", limit: 2, holders: [3, 9, 1] }, [
        summary(1, "idle"),
        summary(3, "running", true),
      ])
    ).toStrictEqual([
      { id: 3, title: "#3", running: true, pausing: true },
      { id: 1, title: "#1", running: false, pausing: false },
    ]);
  });
});

describe(shortageText, () => {
  it("names the resource and its limit", () => {
    expect(shortageText({ resource: "desktop", limit: 1, holders: [] })).toBe(
      "The only desktop sandbox is in use."
    );
    expect(shortageText({ resource: "seat", limit: 10, holders: [] })).toBe(
      "All 10 active conversations are in use."
    );
  });
});
