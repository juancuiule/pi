import { beforeEach, describe, expect, it } from "vitest";

import { useDraft } from "./draft";

describe(useDraft, () => {
  beforeEach(() => useDraft.setState({ draft: undefined }));

  it("hands an offered draft to one taker", () => {
    useDraft.getState().offer("/skill:convert ");
    expect(useDraft.getState().draft).toBe("/skill:convert ");
    expect(useDraft.getState().take()).toBe("/skill:convert ");
    expect(useDraft.getState().take()).toBeUndefined();
  });
});
