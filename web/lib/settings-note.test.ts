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

  it("says what an Upgrade raised and added", () => {
    expect(
      [
        {
          by: "person",
          changes: [{ type: "software", added: ["node", "uv"] }],
        },
        {
          by: "person",
          changes: [
            { type: "level", from: "shell", to: "desktop" },
            { type: "software", added: ["chrome"] },
          ],
        },
      ].map(settingsNote)
    ).toStrictEqual([
      "You added Node.js 24, uv (Python packages)",
      "You upgraded to a desktop and added Google Chrome",
    ]);
  });

  it("says the server switched a model it does not have", () => {
    expect(
      settingsNote({
        by: "server",
        changes: [{ type: "model", from: "ollama/qwen", to: "faux/faux-1" }],
      })
    ).toBe("Switched to faux/faux-1: the model ollama/qwen is not available");
  });
});
