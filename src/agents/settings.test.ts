import { describe, expect, it } from "vitest";

import { applyChange, changesBetween, describeSettings } from "./settings.ts";
import type { InstalledExtension, SettingsState } from "./settings.ts";

const tool = (name: string, approval = false) => ({
  name,
  description: "",
  approval,
});

const installed: InstalledExtension[] = [
  {
    name: "calculator",
    tools: [tool("calculate")],
    levels: ["none", "shell", "desktop"],
    locked: false,
  },
  {
    name: "coding-tools",
    tools: [tool("read"), tool("bash", true)],
    levels: ["shell", "desktop"],
    locked: false,
  },
  {
    name: "skills",
    tools: [tool("skill")],
    levels: ["none", "shell", "desktop"],
    locked: false,
  },
  {
    name: "tracing",
    tools: [],
    levels: ["none", "shell", "desktop"],
    locked: true,
  },
];

const catalog = [
  { name: "convert", description: "Units" },
  { name: "notes", description: "Notes" },
];

const chat: SettingsState = {
  level: "none",
  approvals: "ask",
  extensions: ["calculator", "skills", "tracing"],
  disabledTools: [],
  skills: ["convert", "notes"],
};

describe(applyChange, () => {
  it("turns extensions, tools and skills off and on, and sets the approval policy", () => {
    expect(
      applyChange(installed, catalog, chat, {
        approvals: "auto",
        extensions: { calculator: false },
        tools: { skill: false },
        skills: { notes: false },
      })
    ).toStrictEqual({
      level: "none",
      approvals: "auto",
      extensions: ["skills", "tracing"],
      disabledTools: ["skill"],
      skills: ["convert"],
    });
  });

  it("refuses a locked extension, one the Level does not allow, and unknown names", () => {
    expect(
      [
        { extensions: { tracing: false } },
        { extensions: { "coding-tools": true } },
        { tools: { nope: false } },
        { skills: { nope: true } },
      ].map((change) => applyChange(installed, catalog, chat, change))
    ).toStrictEqual([
      { name: "tracing", reason: "always on" },
      { name: "coding-tools", reason: "needs a shell; upgrade first" },
      { name: "nope", reason: "no such tool" },
      { name: "nope", reason: "no such skill" },
    ]);
  });

  it("turns the skills extension on with a skill, unless the same change turns it off", () => {
    const none = { ...chat, extensions: ["calculator", "tracing"], skills: [] };
    expect(
      [
        applyChange(installed, catalog, none, { skills: { convert: true } }),
        applyChange(installed, catalog, none, {
          skills: { convert: true },
          extensions: { skills: false },
        }),
      ].map((result) => ("extensions" in result ? result.extensions : result))
    ).toStrictEqual([
      ["calculator", "skills", "tracing"],
      ["calculator", "tracing"],
    ]);
  });
});

describe(describeSettings, () => {
  it("marks what is on, what the Level allows, and what is locked", () => {
    const settings = describeSettings(installed, catalog, {
      ...chat,
      disabledTools: ["skill"],
      skills: ["convert"],
    });
    expect(
      settings.extensions.map((each) => [
        each.name,
        each.enabled,
        each.available,
        each.locked,
        each.tools.filter((t) => !t.enabled).map((t) => t.name),
      ])
    ).toStrictEqual([
      ["calculator", true, true, false, []],
      ["coding-tools", false, false, false, []],
      ["skills", true, true, false, ["skill"]],
      ["tracing", true, true, true, []],
    ]);
    expect(settings.skills.map((s) => [s.name, s.enabled])).toStrictEqual([
      ["convert", true],
      ["notes", false],
    ]);
  });
});

describe(changesBetween, () => {
  it("lists what was turned on and off, and a new policy", () => {
    const after = applyChange(installed, catalog, chat, {
      approvals: "auto",
      extensions: { calculator: false },
      tools: { skill: false },
      skills: { notes: false },
    });
    expect(
      "reason" in after ? after : changesBetween(chat, after)
    ).toStrictEqual([
      { type: "approvals", policy: "auto" },
      { type: "extension", name: "calculator", on: false },
      { type: "tool", name: "skill", on: false },
      { type: "skill", name: "notes", on: false },
    ]);
  });
});

describe("the skills extension", () => {
  it("stays off through an unrelated change, and goes with the last skill", () => {
    const off = applyChange(installed, catalog, chat, {
      extensions: { skills: false },
    });
    const unrelated =
      "reason" in off
        ? off
        : applyChange(installed, catalog, off, { approvals: "auto" });
    const lastSkill = applyChange(installed, catalog, chat, {
      skills: { convert: false, notes: false },
    });
    expect(
      [unrelated, lastSkill].map((result) =>
        "reason" in result ? result : result.extensions.includes("skills")
      )
    ).toStrictEqual([false, false]);
  });
});
