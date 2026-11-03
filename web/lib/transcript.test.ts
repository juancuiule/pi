import type { Message } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  displayParts,
  isNearBottom,
  shouldSubmit,
  userParts,
} from "./transcript";

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

describe(displayParts, () => {
  it("shows a scheduled message as typed, with the schedule that sent it", () => {
    const parts = displayParts(
      [
        '<scheduled_run schedule="sch_1" title="Stretch" due="2026-11-04T09:00:00.000-05:00">',
        "A schedule sent this message at its due time; the person did not type it just now. Do what it asks, then answer as usual.",
        "</scheduled_run>",
        "",
        "Remind me to stretch.",
      ].join("\n")
    );
    expect({ shown: parts.shown, title: parts.schedule?.title }).toStrictEqual({
      shown: "Remind me to stretch.",
      title: "Stretch",
    });
  });
});
