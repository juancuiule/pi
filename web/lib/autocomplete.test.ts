import { describe, expect, it } from "vitest";

import { complete, moveSelection } from "./autocomplete";

describe(complete, () => {
  it("replaces the word and puts the caret after the insert", () => {
    expect(
      complete("see @ap", { start: 4, end: 7 }, { insert: "@src/app.ts " })
    ).toStrictEqual({ prompt: "see @src/app.ts ", cursor: 16 });
  });

  it("drops one following space when the insert ends with one", () => {
    expect(
      complete("see @ap then", { start: 4, end: 7 }, { insert: "@a.md " })
    ).toStrictEqual({ prompt: "see @a.md then", cursor: 10 });
  });

  it("keeps the following text as it is when the insert ends without a space", () => {
    expect(
      complete("see @s then", { start: 4, end: 6 }, { insert: "@src/" })
    ).toStrictEqual({ prompt: "see @src/ then", cursor: 9 });
  });
});

describe(moveSelection, () => {
  it("wraps around", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
