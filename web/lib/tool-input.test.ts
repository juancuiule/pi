import { describe, expect, it } from "vitest";

import {
  diffOf,
  diffRowsOf,
  editHunksOf,
  fileLanguage,
  isEditConfirmation,
} from "./tool-input";

describe(fileLanguage, () => {
  it.each([
    ["/workspace/factorial.py", "python"],
    ["src/app.tsx", "tsx"],
    ["a.TOML", "toml"],
    ["Makefile", "text"],
    ["notes.txt", "text"],
    ["/a/b/unknown.qq", "text"],
  ])("%s → %s", (path, language) => {
    expect(fileLanguage(path)).toBe(language);
  });

  it("falls back to text without a path", () => {
    expect(fileLanguage()).toBe("text");
  });
});

describe(editHunksOf, () => {
  it("reads the edits array", () => {
    expect(
      editHunksOf({
        path: "x",
        edits: [{ oldText: "a", newText: "b" }],
      })
    ).toStrictEqual([{ oldText: "a", newText: "b" }]);
  });

  it("parses a JSON-string edits argument", () => {
    expect(
      editHunksOf({ edits: '[{"oldText":"a","newText":"b"}]' })
    ).toStrictEqual([{ oldText: "a", newText: "b" }]);
  });

  it("reads a legacy top-level oldText/newText pair", () => {
    expect(
      editHunksOf({ path: "x", oldText: "a", newText: "b" })
    ).toStrictEqual([{ oldText: "a", newText: "b" }]);
  });

  it("drops malformed edits and reports nothing otherwise", () => {
    expect(editHunksOf({ edits: [{ oldText: 1 }] })).toStrictEqual([]);
    expect(editHunksOf({ edits: "not json" })).toStrictEqual([]);
    expect(editHunksOf({ path: "x" })).toStrictEqual([]);
    expect(editHunksOf()).toStrictEqual([]);
  });
});

describe(diffOf, () => {
  it("reads a non-empty diff string from details", () => {
    expect(diffOf({ diff: "+1 a" })).toBe("+1 a");
    expect(diffOf({ diff: "" })).toBeUndefined();
    expect(diffOf({})).toBeUndefined();
    expect(diffOf("x")).toBeUndefined();
  });
});

describe(diffRowsOf, () => {
  it("classifies rows by their leading sigil", () => {
    expect(diffRowsOf(" 1 ctx\n-2 old\n+2 new\n    ...")).toStrictEqual([
      { variant: "default", text: "1 ctx" },
      { variant: "removed", text: "2 old" },
      { variant: "added", text: "2 new" },
      { variant: "default", text: "   ..." },
    ]);
  });
});

describe(isEditConfirmation, () => {
  it("matches only the boilerplate success line", () => {
    expect(
      isEditConfirmation("Successfully replaced 1 block(s) in x.")
    ).toBeTruthy();
    expect(isEditConfirmation("real output")).toBeFalsy();
  });
});
