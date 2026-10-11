import type { AgentEvent, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { applyEvent, initialState } from "./conversation-state";
import { terminalText } from "./terminal";

const entry = (id: number, message: unknown) =>
  ({
    id,
    conversationId: 1,
    kind: "test",
    model: [message],
  }) as unknown as EntryRecord;

describe(terminalText, () => {
  it("shows each bash command with its final or live output, other tools omitted", () => {
    const events = [
      {
        type: "entry_appended",
        entry: entry(1, {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "a",
              name: "bash",
              arguments: { command: "uname" },
            },
            {
              type: "toolCall",
              id: "b",
              name: "read",
              arguments: { path: "x" },
            },
            {
              type: "toolCall",
              id: "c",
              name: "bash",
              arguments: { command: "sleep 9" },
            },
          ],
        }),
      },
      {
        type: "entry_appended",
        entry: entry(2, {
          role: "toolResult",
          toolCallId: "a",
          content: [{ type: "text", text: "Linux\n" }],
        }),
      },
      {
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "bash",
        output: { append: "partial" },
      },
    ];
    let state = initialState;
    for (const event of events) {
      state = applyEvent(state, event as AgentEvent);
    }

    expect(terminalText(state)).toBe(
      "$ uname\r\nLinux\r\n$ sleep 9\r\npartial"
    );
  });
});
