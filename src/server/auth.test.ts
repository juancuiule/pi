import { describe, expect, it } from "vitest";

import { conversationsNamed } from "./auth.ts";

describe(conversationsNamed, () => {
  it("names the Conversation of a path and of a conversation query", () => {
    expect(conversationsNamed("/api/conversations/12/events")).toStrictEqual([
      12,
    ]);
    expect(conversationsNamed("/api/conversations/12")).toStrictEqual([12]);
    expect(
      conversationsNamed("/api/artifacts/art_1/render?conversation=7&v=2")
    ).toStrictEqual([7]);
    expect(
      conversationsNamed(
        "/api/attachments/a/view?conversation=1&conversation=2"
      )
    ).toStrictEqual([1, 2]);
  });

  it("names nothing for routes that are not a Conversation's", () => {
    expect(conversationsNamed("/api/conversations")).toStrictEqual([]);
    expect(conversationsNamed("/api/conversations?x=1")).toStrictEqual([]);
    expect(conversationsNamed("/api/artifacts")).toStrictEqual([]);
    expect(conversationsNamed("/api/search?q=conversations")).toStrictEqual([]);
  });

  it("reads every spelling an endpoint could decode as a number", () => {
    expect(
      [
        "/api/conversations/%31/events",
        "/api/conversations/+1/events",
        "/api/conversations/1.0/events",
        "/api/conversations/01",
        "/api/./conversations/1",
        "/api/artifacts/x?conversation=%201",
      ].map(conversationsNamed)
    ).toStrictEqual([[1], [1], [1], [1], [1], [1]]);
  });
});
