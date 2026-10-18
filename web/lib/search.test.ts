import { describe, expect, it } from "vitest";

import { isSearchShortcut } from "./search";

const event = (init: {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
}) => ({ metaKey: false, ctrlKey: false, ...init });

describe(isSearchShortcut, () => {
  it("matches ⌘K and Ctrl+K", () => {
    expect(isSearchShortcut(event({ key: "k", metaKey: true }))).toBeTruthy();
    expect(isSearchShortcut(event({ key: "k", ctrlKey: true }))).toBeTruthy();
    expect(
      isSearchShortcut(event({ key: "k", metaKey: true, ctrlKey: true }))
    ).toBeTruthy();
  });

  it("matches an upper-case K from a shifted chord", () => {
    expect(isSearchShortcut(event({ key: "K", metaKey: true }))).toBeTruthy();
  });

  it("ignores an unmodified K and other modified keys", () => {
    expect(isSearchShortcut(event({ key: "k" }))).toBeFalsy();
    expect(isSearchShortcut(event({ key: "p", metaKey: true }))).toBeFalsy();
    expect(
      isSearchShortcut(event({ key: "Enter", ctrlKey: true }))
    ).toBeFalsy();
  });
});

describe("key repeat", () => {
  it("ignores auto-repeated shortcuts", () => {
    expect(
      isSearchShortcut({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        repeat: true,
      })
    ).toBeFalsy();
  });
});
