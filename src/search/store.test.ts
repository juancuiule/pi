import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { matchQuery, splitSnippet } from "./format.ts";
import { sqliteIndex } from "./store.ts";

const row = (
  entryId: number,
  text: string,
  role: "user" | "assistant" = "user",
  createdAt = entryId
) => ({ entryId, role, text, createdAt });

describe(sqliteIndex, () => {
  it("reports a cursor of 0 before any page", () => {
    const index = sqliteIndex(":memory:");
    expect(index.cursorOf(1)).toBe(0);
    index.close();
  });

  it("finds indexed text with a marked snippet and a rank", () => {
    const index = sqliteIndex(":memory:");
    index.putPage(1, 9, [
      row(4, "the echidna lays eggs", "user"),
      row(9, "monotremes are odd", "assistant"),
    ]);
    const hits = index.query('"echidna"*', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      conversationId: 1,
      entryId: 4,
      role: "user",
      createdAt: 4,
    });
    expect(
      splitSnippet(hits[0]?.snippet ?? "").some(
        (segment) => segment.match && segment.text === "echidna"
      )
    ).toBeTruthy();
    expect(hits[0]?.rank).toBeTypeOf("number");
    index.close();
  });

  it("indexes the title under a row without an entry", () => {
    const index = sqliteIndex(":memory:");
    index.putTitle(2, "quokka notes", 50);
    const hits = index.query('"quokka"*', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      conversationId: 2,
      entryId: undefined,
      role: "title",
      createdAt: 50,
    });
    index.close();
  });

  it("advances the cursor over a page, including an empty one", () => {
    const index = sqliteIndex(":memory:");
    index.putPage(1, 12, [row(10, "anything")]);
    expect(index.cursorOf(1)).toBe(12);
    index.putPage(1, 20, []);
    expect(index.cursorOf(1)).toBe(20);
    index.close();
  });

  it("replaces rows instead of duplicating them on a re-run", () => {
    const index = sqliteIndex(":memory:");
    index.putPage(1, 5, [row(4, "same words")]);
    index.putPage(1, 5, [row(4, "same words")]);
    expect(index.query('"words"*', 10)).toHaveLength(1);
    expect(index.cursorOf(1)).toBe(5);
    index.close();
  });

  it("requires every query term", () => {
    const index = sqliteIndex(":memory:");
    index.putPage(1, 2, [row(1, "only alpha appears")]);
    expect(index.query(matchQuery("alpha beta") ?? "", 10)).toHaveLength(0);
    expect(index.query(matchQuery("alpha") ?? "", 10)).toHaveLength(1);
    index.close();
  });

  it("keeps rows and cursors across reopen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-search-store-"));
    try {
      const file = path.join(dir, "search.sqlite");
      const first = sqliteIndex(file);
      first.putPage(7, 42, [row(40, "persistent")]);
      first.close();
      const second = sqliteIndex(file);
      expect(second.cursorOf(7)).toBe(42);
      expect(second.query('"persistent"*', 10)).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
