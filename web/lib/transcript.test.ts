import type { Message } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { isNearBottom, shouldSubmit, userParts } from "./transcript";

describe(isNearBottom, () => {
  it("is true within the threshold and false beyond it", () => {
    const base = { scrollHeight: 1000, clientHeight: 400 };
    expect(isNearBottom({ ...base, scrollTop: 600 })).toBeTruthy();
    expect(isNearBottom({ ...base, scrollTop: 520 })).toBeTruthy();
    expect(isNearBottom({ ...base, scrollTop: 519 })).toBeFalsy();
  });
});

describe(shouldSubmit, () => {
  it("submits on a plain Enter only", () => {
    const key = { key: "Enter", shiftKey: false, isComposing: false };
    expect(shouldSubmit(key)).toBeTruthy();
    expect(shouldSubmit({ ...key, shiftKey: true })).toBeFalsy();
    expect(shouldSubmit({ ...key, isComposing: true })).toBeFalsy();
    expect(shouldSubmit({ ...key, key: "a" })).toBeFalsy();
  });
});

describe(userParts, () => {
  it("passes a string through", () => {
    const message = { role: "user", content: "hi" } as Message;
    expect(userParts(message as never)).toStrictEqual({
      text: "hi",
      images: [],
    });
  });

  it("joins text blocks and turns images into data URLs", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    } as Message;
    expect(userParts(message as never)).toStrictEqual({
      text: "a\nb",
      images: [{ src: "data:image/png;base64,AAA" }],
    });
  });
});
