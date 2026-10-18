import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { indexedText, matchQuery, splitSnippet } from "./format.ts";

const entry = (
  kind: string,
  message?: UserMessage | AssistantMessage,
  extra: Partial<EntryRecord> = {}
): EntryRecord => ({
  id: 7 as EntryId,
  conversationId: 2 as ConversationId,
  kind,
  ...(message === undefined ? {} : { model: [message] }),
  ...extra,
});

const user = (
  content: UserMessage["content"],
  timestamp = 1000
): UserMessage => ({ role: "user", content, timestamp });

const assistant = (
  content: AssistantMessage["content"],
  timestamp = 2000
): AssistantMessage =>
  ({
    role: "assistant",
    content,
    stopReason: "stop",
    timestamp,
  }) as AssistantMessage;

describe(indexedText, () => {
  it("takes a user message's text and timestamp", () => {
    expect(indexedText(entry("pi.user", user("hello there")))).toStrictEqual({
      role: "user",
      text: "hello there",
      createdAt: 1000,
    });
  });

  it("joins a user message's text parts, skipping images", () => {
    expect(
      indexedText(
        entry(
          "pi.user",
          user([
            { type: "text", text: "see " },
            { type: "image", data: "QUJD", mimeType: "image/png" },
            { type: "text", text: "the attachment" },
          ])
        )
      )
    ).toStrictEqual({
      role: "user",
      text: "see \nthe attachment",
      createdAt: 1000,
    });
  });

  it("takes only an assistant message's text parts", () => {
    expect(
      indexedText(
        entry(
          "pi.assistant",
          assistant([
            { type: "thinking", thinking: "hidden deliberation" },
            { type: "text", text: "the answer" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "hidden arguments" },
            },
            { type: "text", text: "more" },
          ])
        )
      )
    ).toStrictEqual({
      role: "assistant",
      text: "the answer\nmore",
      createdAt: 2000,
    });
  });

  it("skips every other kind, including boundaries carrying user-role messages", () => {
    for (const kind of [
      "pi.tool-result",
      "pi.system",
      "app.settings",
      "anything.else",
    ]) {
      expect(indexedText(entry(kind, user("hidden")))).toBeUndefined();
    }
    // A reset's handoff and a compaction's summary are user-role models but not messages.
    expect(indexedText(entry("pi.reset", user("handoff")))).toBeUndefined();
    expect(
      indexedText(entry("pi.compaction", user("summary")))
    ).toBeUndefined();
  });

  it("skips entries with no text", () => {
    expect(indexedText(entry("pi.user"))).toBeUndefined();
    expect(indexedText(entry("pi.user", user("   ")))).toBeUndefined();
    expect(
      indexedText(
        entry(
          "pi.user",
          user([{ type: "image", data: "QUJD", mimeType: "image/png" }])
        )
      )
    ).toBeUndefined();
    expect(
      indexedText(
        entry("pi.assistant", assistant([{ type: "thinking", thinking: "t" }]))
      )
    ).toBeUndefined();
  });
});

describe(matchQuery, () => {
  it("is undefined when the input holds no word characters", () => {
    for (const q of ["", "   ", "!!!()", "– —"]) {
      expect(matchQuery(q)).toBeUndefined();
    }
  });

  it("quotes each term as a prefix and ANDs them", () => {
    expect(matchQuery("unclosed quote")).toBe('"unclosed"* AND "quote"*');
  });

  it("sanitizes FTS syntax out of the terms", () => {
    expect(matchQuery("a:b")).toBe('"a"* AND "b"*');
    expect(matchQuery('"OR AND')).toBe('"OR"* AND "AND"*');
    expect(matchQuery("hello-world")).toBe('"hello"* AND "world"*');
    expect(matchQuery('"unclosed')).toBe('"unclosed"*');
  });
});

describe(splitSnippet, () => {
  it("is empty for an empty snippet", () => {
    expect(splitSnippet("")).toStrictEqual([]);
  });

  it("splits on the match markers, flagging the marked spans", () => {
    expect(
      splitSnippet("the \u0002echidna\u0003 lays \u0002eggs\u0003")
    ).toStrictEqual([
      { text: "the ", match: false },
      { text: "echidna", match: true },
      { text: " lays ", match: false },
      { text: "eggs", match: true },
    ]);
  });
});
