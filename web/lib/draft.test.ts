import { beforeEach, describe, expect, it } from "vitest";

import { focusAfterSheet, useDraft } from "./draft";

describe(useDraft, () => {
  beforeEach(() => useDraft.setState({ draft: undefined }));

  it("hands an offered draft to one taker", () => {
    useDraft.getState().offer("/skill:repo-report ");
    expect(useDraft.getState().draft).toBe("/skill:repo-report ");
    expect(useDraft.getState().take()).toBe("/skill:repo-report ");
    expect(useDraft.getState().take()).toBeUndefined();
  });
});

describe(focusAfterSheet, () => {
  const textarea = { focus: () => {} } as unknown as HTMLElement;

  it("moves focus to the composer after a skill was picked", () => {
    expect(focusAfterSheet(true, textarea)).toBe(textarea);
  });

  it("otherwise lets the sheet restore focus to its trigger", () => {
    expect(focusAfterSheet(false, textarea)).not.toBe(textarea);
    expect(focusAfterSheet(false, textarea)).toBeTruthy();
    expect(focusAfterSheet(true, null)).toBeTruthy();
  });
});
