import { describe, expect, it } from "vitest";

import { apiError } from "./api";

describe(apiError, () => {
  it("explains an unknown skill and lists the available ones", () => {
    expect(
      apiError({ _tag: "SkillNotFound", name: "nope", available: ["a", "b"] })
    ).toBe("No skill named nope. Available: a, b.");
  });
});
