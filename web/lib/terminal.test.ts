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

const run = (messages: unknown[], update?: AgentEvent) => {
  let state = initialState;
  for (const [i, m] of messages.entries()) {
    state = applyEvent(state, {
      type: "entry_appended",
      entry: entry(i + 1, m),
    } as AgentEvent);
  }
  return update === undefined ? state : applyEvent(state, update);
};
const call = (id: string, args?: unknown) => ({
  type: "toolCall",
  id,
  name: "bash",
  ...(args === undefined ? {} : { arguments: args }),
});
const result = (id: string, ...texts: string[]) => ({
  role: "toolResult",
  toolCallId: id,
  content: texts.map((text) => ({ type: "text", text })),
});

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

  it("puts an error result's separate text items on separate lines", () => {
    const state = run([
      {
        role: "assistant",
        content: [
          call("a", { command: "false" }),
          call("b", { command: "ls" }),
        ],
      },
      result("a", "boom", "<harness>exit 1</harness>"),
      result("b", "ok\n"),
    ]);
    expect(terminalText(state)).toBe(
      "$ false\r\nboom\r\n<harness>exit 1</harness>\r\n$ ls\r\nok"
    );
  });

  it("starts the next command on its own line after output without a newline", () => {
    const state = run([
      {
        role: "assistant",
        content: [
          call("a", { command: "printf hi" }),
          call("b", { command: "pwd" }),
        ],
      },
      result("a", "hi"),
      result("b", "/\n"),
    ]);
    expect(terminalText(state)).toBe("$ printf hi\r\nhi\r\n$ pwd\r\n/");
  });

  it("does not throw on a streaming tool call without arguments", () => {
    const state = run([{ role: "assistant", content: [call("a")] }]);
    expect(terminalText(state)).toBe("$ ");
  });
});
