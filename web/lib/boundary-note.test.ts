import type { EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { boundaryNote } from "./boundary-note";

const entry = (partial: object): EntryRecord =>
  ({
    id: 5,
    conversationId: 1,
    kind: "test",
    ...partial,
  }) as unknown as EntryRecord;

/** A `pi.compaction` entry as pi-durable writes it: the wrapped summary as a user message, reason in `data`. */
const compaction = (reason?: string, summary = "did stuff") =>
  entry({
    kind: "pi.compaction",
    head: 3,
    ...(reason === undefined ? {} : { data: { reason } }),
    model: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
          },
        ],
      },
    ],
  });

describe(boundaryNote, () => {
  it("is undefined for entries without a head", () => {
    expect(boundaryNote(entry({ kind: "pi.user" }))).toBeUndefined();
    expect(
      boundaryNote(
        entry({ model: [{ role: "user", content: "hi" }], kind: "pi.user" })
      )
    ).toBeUndefined();
  });

  it("names a compaction by its reason and unwraps the summary", () => {
    expect(
      boundaryNote(compaction("threshold", "summarized so far"))
    ).toStrictEqual({
      kind: "compaction",
      title: "Context compacted (threshold)",
      reason: "threshold",
      body: "summarized so far",
    });
  });

  it("labels a compaction without a reason plainly", () => {
    expect(boundaryNote(compaction())).toStrictEqual({
      kind: "compaction",
      title: "Context compacted",
      body: "did stuff",
    });
  });

  it("keeps a summary text that lost its wrapper", () => {
    const bare = compaction("manual", "wrapped");
    const text = "an unwrapped summary";
    const record = {
      ...bare,
      model: [{ role: "user", content: [{ type: "text", text }] }],
    } as unknown as EntryRecord;
    expect(boundaryNote(record)?.body).toBe(text);
  });

  it("labels a reset, carrying its handoff text", () => {
    expect(
      boundaryNote(
        entry({
          kind: "pi.reset",
          head: 5,
          model: [{ role: "user", content: "carry on" }],
        })
      )
    ).toStrictEqual({
      kind: "reset",
      title: "Conversation reset",
      body: "carry on",
    });
  });

  it("labels a plain reset and has no body", () => {
    expect(boundaryNote(entry({ kind: "pi.reset", head: 5 }))).toStrictEqual({
      kind: "reset",
      title: "Conversation reset",
      body: "",
    });
  });

  it("names any other head-marked kind after the kind itself", () => {
    expect(boundaryNote(entry({ kind: "pi.fork", head: 2 }))).toStrictEqual({
      kind: "boundary",
      title: "pi.fork",
      body: "",
    });
  });
});
