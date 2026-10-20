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
      name: "calculator",
      levels: ["none", "shell", "desktop"],
      tools: [tool("calculate")],
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
    {
      name: "browser",
      levels: ["shell", "desktop"],
      software: "agent-browser",
      tools: [tool("browser_open")],
      sections: ["browser"],
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

const browser = (level: "none" | "shell", software: "agent-browser"[]) =>
  newConversationSettings(
    capabilities,
    level,
    software,
    NO_OVERRIDES
  ).extensions.find((e) => e.name === "browser");

const enabledOf = (settings: ReturnType<typeof newConversationSettings>) =>
  settings.extensions.filter((e) => e.enabled).map((e) => e.name);

describe(newConversationSettings, () => {
  it("turns on what the Level allows", () => {
    expect(
      [
        newConversationSettings(capabilities, "none", [], NO_OVERRIDES),
        newConversationSettings(capabilities, "shell", [], NO_OVERRIDES),
      ].map(enabledOf)
    ).toStrictEqual([
      ["calculator", "skills"],
      ["calculator", "coding-tools", "skills"],
    ]);
  });

  it("turns on an extension that needs Software only when it is picked, at a Level that offers it", () => {
    expect(
      [
        browser("shell", []),
        browser("shell", ["agent-browser"]),
        browser("none", ["agent-browser"]),
      ].map((e) => [e?.available, e?.enabled, e?.software])
    ).toStrictEqual([
      [false, false, "agent-browser"],
      [true, true, "agent-browser"],
      [false, false, "agent-browser"],
    ]);
  });

  it("applies flipped switches, and keeps the skills extension without skills", () => {
    let overrides = flip(NO_OVERRIDES, "tools", "bash", false);
    overrides = flip(overrides, "skills", "convert", false);
    overrides = flip(overrides, "skills", "notes", false);
    const settings = newConversationSettings(
      capabilities,
      "shell",
      [],
      overrides
    );
    expect([
      enabledOf(settings),
      settings.extensions
        .find((e) => e.name === "coding-tools")
        ?.tools.map((t) => [t.name, t.enabled]),
      isEmpty(overrides),
      isEmpty(NO_OVERRIDES),
    ]).toStrictEqual([
      ["calculator", "coding-tools", "skills"],
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
    const chat = newConversationSettings(capabilities, "none", [], flipped);
    const shell = newConversationSettings(capabilities, "shell", [], flipped);
    expect([
      settingsPayload(flipped, chat),
      settingsPayload(flipped, shell),
    ]).toStrictEqual([
      undefined,
      { extensions: { "coding-tools": true }, tools: {}, skills: {} },
    ]);
  });
});
