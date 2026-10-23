import type { EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { approvalOf, waitingCalls } from "./approval";
import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

describe(approvalOf, () => {
  it("reads pending and approved states", () => {
    const cases = [
      [
        { approval: "pending", approvalKey: "1:c1" },
        { state: "pending", key: "1:c1" },
      ],
      [{ approval: "approved" }, { state: "approved" }],
      [{ approval: "denied" }, { state: "denied" }],
      [{ approval: "stopped" }, { state: "stopped" }],
      [{ approval: "pending" }, undefined],
      [{ ansi: "x" }, undefined],
      ["text", undefined],
      [undefined, undefined],
    ];
    expect(cases.map(([input]) => approvalOf(input))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});

const callEntry = (id: number, ...callIds: string[]): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "message",
    model: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "On it." },
          ...callIds.map((callId) => ({
            type: "toolCall",
            id: callId,
            name: "bash",
            arguments: {},
          })),
        ],
      },
    ],
  }) as unknown as EntryRecord;

const resultEntry = (id: number, callId: string): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "message",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        content: [],
        details: { approval: "approved" },
      },
    ],
  }) as unknown as EntryRecord;

const slot = (details: unknown) => ({ status: "running", output: "", details });

const stateOf = (
  entries: readonly EntryRecord[],
  tools: Record<string, unknown>
) => ({ ...initialState, entries, tools }) as unknown as ConversationState;

describe(waitingCalls, () => {
  it("lists pending calls without a result, in transcript order", () => {
    const entries = [callEntry(1, "a", "b"), callEntry(2, "c")];
    const state = stateOf(entries, {
      a: slot({ approval: "pending", approvalKey: "1:a" }),
      c: slot({ approval: "pending", approvalKey: "1:c" }),
    });
    expect(waitingCalls(entries, state).map((call) => call.id)).toStrictEqual([
      "a",
      "c",
    ]);
  });

  it.each(["approved", "denied", "stopped", "answered", "skipped"])(
    "leaves out a call whose live details say %s",
    (approval) => {
      const entries = [callEntry(1, "a")];
      const state = stateOf(entries, { a: slot({ approval }) });
      expect(waitingCalls(entries, state)).toStrictEqual([]);
    }
  );

  it("leaves out a call whose result is committed, even with a stale pending slot", () => {
    const entries = [callEntry(1, "a"), resultEntry(2, "a")];
    const state = stateOf(entries, {
      a: slot({ approval: "pending", approvalKey: "1:a" }),
    });
    expect(waitingCalls(entries, state)).toStrictEqual([]);
  });
});
