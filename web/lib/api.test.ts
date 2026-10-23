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

describe("sign-in errors", () => {
  it("explains wrong credentials, the wait after too many, and refused accounts", () => {
    expect([
      apiError({ _tag: "InvalidCredentials" }),
      apiError({ _tag: "TooManyAttempts", retryAfterMs: 29_100 }),
      apiError({ _tag: "TooManyAttempts", retryAfterMs: 400 }),
      apiError({ _tag: "InvalidAccount", reason: "The name is taken." }),
    ]).toStrictEqual([
      "Wrong name or password.",
      "Too many failed attempts. Try again in 30 seconds.",
      "Too many failed attempts. Try again in 1 second.",
      "The name is taken.",
    ]);
  });
});

describe("capacity errors", () => {
  it("asks to wait when other people hold the whole limit", () => {
    expect([
      apiError({
        _tag: "CapacityExhausted",
        resource: "shell",
        limit: 3,
        holders: [4],
      }),
      apiError({
        _tag: "CapacityExhausted",
        resource: "shell",
        limit: 3,
        holders: [],
      }),
    ]).toStrictEqual([
      "At most 3 shell sandboxes can run at once. Pause one first.",
      "The server is busy with other people's conversations. Try again later.",
    ]);
  });
});
