import type { Capabilities } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  flip,
  isEmpty,
  newConversationSettings,
  NO_OVERRIDES,
  settingsPayload,
} from "./settings";

const tool = (name: string) => ({ name, description: "", approval: false });

const capabilities: Capabilities = {
  extensions: [
    {
      name: "questions",
      levels: ["none", "shell", "desktop"],
      tools: [tool("ask_user")],
      sections: [],
      hooks: 0,
      locked: false,
    },
    {
      name: "coding-tools",
      levels: ["shell", "desktop"],
      tools: [tool("read"), tool("bash")],
      sections: [],
      hooks: 0,
      locked: false,
    },
    {
      name: "skills",
      levels: ["none", "shell", "desktop"],
      tools: [tool("skill")],
      sections: ["skills"],
      hooks: 0,
      locked: false,
    },
  ],
  skills: [
    {
      name: "convert",
      description: "",
      modelInvocable: true,
      origin: "builtin" as const,
      files: ["SKILL.md"],
      body: "",
    },
    {
      name: "notes",
      description: "",
      modelInvocable: true,
      origin: "builtin" as const,
      files: ["SKILL.md"],
      body: "",
    },
  ],
  skillProblems: [],
  mcp: [],
  software: [],
};

const enabledOf = (settings: ReturnType<typeof newConversationSettings>) =>
  settings.extensions.filter((e) => e.enabled).map((e) => e.name);

describe(newConversationSettings, () => {
  it("turns on what the Level allows", () => {
    expect(
      [
        newConversationSettings(capabilities, "none", NO_OVERRIDES),
        newConversationSettings(capabilities, "shell", NO_OVERRIDES),
      ].map(enabledOf)
    ).toStrictEqual([
      ["questions", "skills"],
      ["questions", "coding-tools", "skills"],
    ]);
  });

  it("applies flipped switches, and keeps the skills extension without skills", () => {
    let overrides = flip(NO_OVERRIDES, "tools", "bash", false);
    overrides = flip(overrides, "skills", "convert", false);
    overrides = flip(overrides, "skills", "notes", false);
    const settings = newConversationSettings(capabilities, "shell", overrides);
    expect([
      enabledOf(settings),
      settings.extensions
        .find((e) => e.name === "coding-tools")
        ?.tools.map((t) => [t.name, t.enabled]),
      isEmpty(overrides),
      isEmpty(NO_OVERRIDES),
    ]).toStrictEqual([
      ["questions", "coding-tools", "skills"],
      [
        ["read", true],
        ["bash", false],
      ],
      false,
      true,
    ]);
  });
});

describe(settingsPayload, () => {
  it("drops extension switches the Level does not allow, and sends nothing when nothing is left", () => {
    const flipped = flip(NO_OVERRIDES, "extensions", "coding-tools", true);
    const chat = newConversationSettings(capabilities, "none", flipped);
    const shell = newConversationSettings(capabilities, "shell", flipped);
    expect([
      settingsPayload(flipped, chat),
      settingsPayload(flipped, shell),
    ]).toStrictEqual([
      undefined,
      { extensions: { "coding-tools": true }, tools: {}, skills: {} },
    ]);
  });
});
