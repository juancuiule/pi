import { describe, expect, it } from "vitest";

import { settingsNote } from "./settings-note";

describe(settingsNote, () => {
  it("says who changed what", () => {
    expect(
      [
        {
          by: "person",
          changes: [
            { type: "tool", name: "bash", on: false },
            { type: "approvals", policy: "auto" },
          ],
        },
        {
          by: "agent",
          changes: [{ type: "level", from: "none", to: "shell" }],
        },
        { by: "person", reset: true, changes: [] },
        { other: true },
      ].map(settingsNote)
    ).toStrictEqual([
      "You changed settings: bash off, approvals off (auto)",
      "The agent upgraded to a shell",
      "You reset the settings to their defaults",
      undefined,
    ]);
  });
});
