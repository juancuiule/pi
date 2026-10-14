import type { AgentEvent, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { applyEvent, initialState } from "./conversation-state";
import { TERMINAL_RESET, terminalText, terminalWrite } from "./terminal";

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
const resultWithAnsi = (id: string, text: string, ansi: string) => ({
  role: "toolResult",
  toolCallId: id,
  content: [{ type: "text", text }],
  details: { ansi },
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

  it("prefers the raw ANSI stream in a finished call's details", () => {
    const state = run([
      { role: "assistant", content: [call("a", { command: "tput" })] },
      resultWithAnsi("a", "red plain\n", "\u001B[31mred\u001B[0m plain\n"),
    ]);
    expect(terminalText(state)).toBe("$ tput\r\n\u001B[31mred\u001B[0m plain");
  });

  it("uses a running call's details.ansi over its live output", () => {
    const state = run(
      [
        {
          role: "assistant",
          content: [call("a", { command: "make" })],
        },
      ],
      {
        type: "tool_execution_update",
        toolCallId: "a",
        toolName: "bash",
        output: { set: "step 1" },
        details: { ansi: "\u001B[36mstep 1\u001B[0m" },
      } as AgentEvent
    );
    expect(terminalText(state)).toBe("$ make\r\n\u001B[36mstep 1\u001B[0m");
  });

  it("falls back to the sanitized content when there are no details", () => {
    const state = run([
      { role: "assistant", content: [call("a", { command: "ls" })] },
      result("a", "file.txt\n"),
    ]);
    expect(terminalText(state)).toBe("$ ls\r\nfile.txt");
  });

  it("hides a call that is still waiting for approval", () => {
    const state = run(
      [
        { role: "assistant", content: [call("a", { command: "ls" })] },
        { role: "assistant", content: [call("b", { command: "pwd" })] },
        result("b", "/work\n"),
      ],
      {
        type: "tool_execution_update",
        toolCallId: "a",
        toolName: "bash",
        details: { approval: "pending", approvalKey: "1:a" },
      } as AgentEvent
    );
    expect(terminalText(state)).toBe("$ pwd\r\n/work");
  });

  it("hides a denied call", () => {
    const state = run([
      { role: "assistant", content: [call("a", { command: "rm -rf" })] },
      {
        role: "toolResult",
        toolCallId: "a",
        isError: true,
        content: [{ type: "text", text: "The user denied this tool call." }],
        details: { approval: "denied" },
      },
    ]);
    expect(terminalText(state)).toBe("");
  });

  it("hides a call stopped before its approval", () => {
    const state = run([
      { role: "assistant", content: [call("a", { command: "rm -rf" })] },
      {
        role: "toolResult",
        toolCallId: "a",
        isError: true,
        content: [
          { type: "text", text: "Stopped by the user before approval." },
        ],
        details: { approval: "stopped" },
      },
    ]);
    expect(terminalText(state)).toBe("");
  });
});

describe(terminalWrite, () => {
  it("writes only the appended suffix", () => {
    expect(terminalWrite("abc", "abcdef")).toBe("def");
  });

  it("writes nothing when the text is unchanged", () => {
    expect(terminalWrite("abc", "abc")).toBe("");
  });

  it("resets and rewrites when a snapshot replaced the text", () => {
    expect(terminalWrite("abc", "xyz")).toBe(`${TERMINAL_RESET}xyz`);
  });

  it("writes the full text when nothing was written before", () => {
    expect(terminalWrite("", "hello")).toBe("hello");
  });
});
