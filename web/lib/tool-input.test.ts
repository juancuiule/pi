import { describe, expect, it } from "vitest";

import { editHunksOf, isEditConfirmation, patchOf } from "./tool-input";

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

describe(patchOf, () => {
  it("reads a non-empty patch string from details", () => {
    expect(patchOf({ patch: "@@ -1 +1 @@\n-a\n+b" })).toBe(
      "@@ -1 +1 @@\n-a\n+b"
    );
    expect(patchOf({ patch: "" })).toBeUndefined();
    expect(patchOf({})).toBeUndefined();
    expect(patchOf("x")).toBeUndefined();
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
