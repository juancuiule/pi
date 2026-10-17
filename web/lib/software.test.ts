import { describe, expect, it } from "vitest";

import {
  canAddSoftware,
  pick,
  softwareChoices,
  softwareToAdd,
} from "./software";
import type { SoftwareEntry } from "./software";

const entries: SoftwareEntry[] = [
  { id: "node", label: "Node.js 24", description: "", level: "shell" },
  {
    id: "uv",
    label: "uv (Python packages)",
    description: "",
    level: "shell",
  },
  { id: "chrome", label: "Google Chrome", description: "", level: "desktop" },
];

const state = (choices: ReturnType<typeof softwareChoices>) =>
  choices.map((choice) => [
    choice.entry.id,
    choice.checked,
    choice.disabled,
    choice.note,
  ]);

describe(softwareChoices, () => {
  it("checks and locks what is installed, and locks what the Level does not offer", () => {
    expect(
      state(softwareChoices(entries, "shell", ["node"], ["uv", "chrome"]))
    ).toStrictEqual([
      ["node", true, true, "Installed"],
      ["uv", true, false, undefined],
      ["chrome", false, true, "Desktop only"],
    ]);
    expect(state(softwareChoices(entries, "none", [], ["node"]))).toStrictEqual(
      [
        ["node", false, true, "Needs a shell"],
        ["uv", false, true, "Needs a shell"],
        ["chrome", false, true, "Desktop only"],
      ]
    );
  });
});

describe(canAddSoftware, () => {
  it("is true while the Level offers something not installed", () => {
    expect([
      canAddSoftware(entries, "none", []),
      canAddSoftware(entries, "shell", ["node"]),
      canAddSoftware(entries, "shell", ["node", "uv"]),
      canAddSoftware(entries, "desktop", ["node", "uv"]),
    ]).toStrictEqual([false, true, false, true]);
  });
});

describe(pick, () => {
  it("adds an entry once and removes it", () => {
    expect([
      pick(["node"], "uv", true),
      pick(["node"], "node", true),
      pick(["node", "uv"], "node", false),
    ]).toStrictEqual([["node", "uv"], ["node"], ["uv"]]);
  });
});

describe(softwareToAdd, () => {
  it("sends the picks the Level allows that are not installed yet", () => {
    const picked = ["chrome", "node", "uv"] as const;
    expect([
      softwareToAdd(entries, "desktop", [], picked),
      softwareToAdd(entries, "shell", [], picked),
      softwareToAdd(entries, "shell", ["node"], picked),
      softwareToAdd(entries, "none", [], picked),
    ]).toStrictEqual([["node", "uv", "chrome"], ["node", "uv"], ["uv"], []]);
  });
});
