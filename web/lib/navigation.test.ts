import type { SearchResult } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  matchCommands,
  NAV_COMMANDS,
  PAGES,
  paletteSections,
} from "./navigation";
import type { PaletteItem } from "./navigation";

const conversation = (id: number): SearchResult => ({
  id,
  title: `Conversation ${id}`,
  archived: false,
  createdAt: id,
  matches: [],
});

const labels = (commands: typeof NAV_COMMANDS) =>
  commands.map((command) => command.label);

describe(matchCommands, () => {
  it("returns the full catalog in issue order for an empty query", () => {
    expect(labels(matchCommands(NAV_COMMANDS, ""))).toStrictEqual([
      "Go to Skills",
      "Go to Artifacts",
      "Go to Capacity",
      "Go to Settings",
      "New conversation",
    ]);
  });

  it("matches on the label", () => {
    expect(labels(matchCommands(NAV_COMMANDS, "skills"))).toStrictEqual([
      "Go to Skills",
    ]);
    expect(labels(matchCommands(NAV_COMMANDS, "new"))).toStrictEqual([
      "New conversation",
    ]);
  });

  it("matches on keywords, case-insensitively", () => {
    expect(labels(matchCommands(NAV_COMMANDS, "perms"))).toStrictEqual([
      "Go to Capacity",
    ]);
    expect(labels(matchCommands(NAV_COMMANDS, "PERMS"))).toStrictEqual([
      "Go to Capacity",
    ]);
    expect(labels(matchCommands(NAV_COMMANDS, "prompts"))).toStrictEqual([
      "Go to Skills",
    ]);
    expect(labels(matchCommands(NAV_COMMANDS, "theme"))).toStrictEqual([
      "Go to Settings",
    ]);
  });

  it("matches on the href", () => {
    expect(labels(matchCommands(NAV_COMMANDS, "/capacity"))).toStrictEqual([
      "Go to Capacity",
    ]);
  });

  it("ignores padding around the query", () => {
    expect(labels(matchCommands(NAV_COMMANDS, "  perms  "))).toStrictEqual([
      "Go to Capacity",
    ]);
    expect(labels(matchCommands(NAV_COMMANDS, "   "))).toStrictEqual(
      labels(NAV_COMMANDS)
    );
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCommands(NAV_COMMANDS, "zzz")).toStrictEqual([]);
  });
});

describe("the command catalog", () => {
  it("has a 'Go to' command at the same href for every page but the conversation list", () => {
    const expected = PAGES.filter((page) => page.href !== "/");
    const goTos = NAV_COMMANDS.slice(0, expected.length);
    for (const [index, page] of expected.entries()) {
      const command = goTos[index];
      expect(command.label).toBe(`Go to ${page.label}`);
      expect("href" in command ? command.href : undefined).toBe(page.href);
    }
  });

  it("ends with New conversation at /", () => {
    const last = NAV_COMMANDS.at(-1);
    expect(last?.label).toBe("New conversation");
    expect(last !== undefined && "href" in last ? last.href : undefined).toBe(
      "/"
    );
  });
});

describe(paletteSections, () => {
  it("lists the matched pages above the conversations", () => {
    const sections = paletteSections("", [conversation(1), conversation(2)]);
    expect(sections.map((section) => section.label)).toStrictEqual([
      "Pages",
      "Conversations",
    ]);
    expect(sections[0].items).toHaveLength(NAV_COMMANDS.length);
    expect(sections[1].items).toHaveLength(2);
  });

  it("indexes items contiguously across the sections", () => {
    const items = paletteSections("skill", [
      conversation(1),
      conversation(2),
    ]).flatMap((section): readonly PaletteItem[] => section.items);
    expect(items.map((item) => item.index)).toStrictEqual(
      items.map((_, index) => index)
    );
  });

  it("omits the pages section when no command matches", () => {
    const sections = paletteSections("zzz", [conversation(1)]);
    expect(sections.map((section) => section.id)).toStrictEqual([
      "conversations",
    ]);
    expect(sections[0].items[0].index).toBe(0);
  });

  it("keeps the conversations section with zero results", () => {
    const sections = paletteSections("", []);
    expect(sections.at(-1)?.id).toBe("conversations");
    expect(sections.at(-1)?.items).toStrictEqual([]);
  });

  it("gives every item a unique key", () => {
    const items = paletteSections("", [
      conversation(1),
      conversation(2),
    ]).flatMap((section): readonly PaletteItem[] => section.items);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});
