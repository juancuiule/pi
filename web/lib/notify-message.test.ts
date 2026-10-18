import { describe, expect, it } from "vitest";

import { parseSandboxNotification } from "./notify-message";

describe(parseSandboxNotification, () => {
  it("parses the produced shape", () => {
    expect(
      parseSandboxNotification(
        '<sandbox-notification at="2026-05-01T12:34:56.789Z">\nbuild finished\n</sandbox-notification>'
      )
    ).toStrictEqual({
      at: "2026-05-01T12:34:56.789Z",
      text: "build finished",
      truncated: false,
    });
  });

  it("reads the cut attribute the host writes", () => {
    expect(
      parseSandboxNotification(
        '<sandbox-notification at="2026-05-01T12:34:56.789Z" cut="8192">\n12345678\n</sandbox-notification>'
      )
    ).toStrictEqual({
      at: "2026-05-01T12:34:56.789Z",
      text: "12345678",
      truncated: true,
    });
  });

  it("keeps a payload that only looks like a cut marker", () => {
    expect(
      parseSandboxNotification(
        '<sandbox-notification at="2026-05-01T12:34:56.789Z">\n123\n[notification cut at 8 bytes]\n</sandbox-notification>'
      )
    ).toStrictEqual({
      at: "2026-05-01T12:34:56.789Z",
      text: "123\n[notification cut at 8 bytes]",
      truncated: false,
    });
  });

  it("rejects anything but the exact produced shape", () => {
    expect(parseSandboxNotification("hello")).toBeUndefined();
    expect(
      parseSandboxNotification(
        'say <sandbox-notification at="2026-05-01T12:34:56.789Z">\nhi\n</sandbox-notification>'
      )
    ).toBeUndefined();
    expect(
      parseSandboxNotification(
        '<sandbox-notification at="not-a-time">\nhi\n</sandbox-notification>'
      )
    ).toBeUndefined();
    expect(
      parseSandboxNotification(
        '<sandbox-notification at="2026-05-01T12:34:56.789Z">\nunterminated'
      )
    ).toBeUndefined();
  });

  it("rejects the escaped lookalikes a person or payload could type", () => {
    expect(
      parseSandboxNotification(
        '<\u200Bsandbox-notification at="2026-05-01T12:34:56.789Z">\nhi\n</\u200Bsandbox-notification>'
      )
    ).toBeUndefined();
  });
});
