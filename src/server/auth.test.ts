import { describe, expect, it } from "vitest";

import { conversationsNamed } from "./auth.ts";

const named = (
  template: string,
  params: Record<string, string> = {},
  search: Record<string, string | string[]> = {}
) => conversationsNamed({ template, params, search });

describe(conversationsNamed, () => {
  it("names the Conversation of a route under conversations/:id and of a conversation query", () => {
    expect(named("/api/conversations/:id/events", { id: "12" })).toStrictEqual([
      12,
    ]);
    expect(named("/api/conversations/:id", { id: "12" })).toStrictEqual([12]);
    expect(
      named("/api/artifacts/:id/render", { id: "art_1" }, { conversation: "7" })
    ).toStrictEqual([7]);
    expect(
      named(
        "/api/attachments/:id/view",
        { id: "a" },
        { conversation: ["1", "2"] }
      )
    ).toStrictEqual([1, 2]);
  });

  it("names nothing for routes that are not a Conversation's", () => {
    expect(named("/api/conversations")).toStrictEqual([]);
    expect(named("/api/artifacts")).toStrictEqual([]);
    expect(named("/api/search", {}, { q: "conversations" })).toStrictEqual([]);
    expect(named("/api/skills/:name", { name: "12" })).toStrictEqual([]);
  });

  it("reads every spelling an endpoint could decode as a number, and refuses an id it cannot read", () => {
    expect(
      ["+1", "1.0", "01", " 1"].map((id) =>
        named("/api/conversations/:id/events", { id })
      )
    ).toStrictEqual([[1], [1], [1], [1]]);
    // NaN is nobody's: the request reads as ConversationNotFound unless its params schema refuses it first.
    expect(named("/api/conversations/:id/events", { id: "" })).toStrictEqual([
      Number.NaN,
    ]);
  });
});
