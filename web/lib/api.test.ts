import { describe, expect, it } from "vitest";

import { apiError } from "./api";

describe(apiError, () => {
  it("explains an unknown skill and lists the available ones", () => {
    expect(
      apiError({ _tag: "SkillNotFound", name: "nope", available: ["a", "b"] })
    ).toBe("No skill named nope. Available: a, b.");
  });
});

describe("title generation errors", () => {
  it("blames the missing model only when that is the reason", () => {
    expect([
      apiError({ _tag: "TitleGenerationFailed", id: 1, reason: "no_model" }),
      apiError({ _tag: "TitleGenerationFailed", id: 1, reason: "no_exchange" }),
      apiError({
        _tag: "TitleGenerationFailed",
        id: 1,
        reason: "model_error",
        message: "The model's answer was empty.",
      }),
    ]).toStrictEqual([
      "No model is configured to write titles.",
      "Couldn't generate a title.",
      "The model's answer was empty.",
    ]);
  });
});

describe("upload errors", () => {
  it("explains refused files and uploads cut off for size", () => {
    expect([
      apiError({
        _tag: "AttachmentRefused",
        reason: "unsupported",
        message: "Only text files.",
      }),
      apiError({
        _tag: "HttpClientError",
        reason: { response: { status: 413 } },
      }),
      apiError({ _tag: "EmptyMessage" }),
    ]).toStrictEqual([
      "Only text files.",
      "The file is too large to upload.",
      "Write a message or attach a file.",
    ]);
  });
});
