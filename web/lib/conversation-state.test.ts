import type { AgentEvent, AssistantMessage, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { applyEvent, initialState, toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

const assistant = (text: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
  }) as AssistantMessage;

const entry = (id: number, message: unknown): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "test",
    model: [message],
  }) as unknown as EntryRecord;

const snapshot = (entries: EntryRecord[], running = false): AgentEvent =>
  ({
    type: "snapshot",
    entries,
    ...(running ? { run: { inputs: [] } } : {}),
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  }) as unknown as AgentEvent;

const foldFrom = (start: ConversationState, events: AgentEvent[]) => {
  let state = start;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
};
const fold = (events: AgentEvent[]) => foldFrom(initialState, events);

describe(applyEvent, () => {
  it("a snapshot replaces all state, so reconnecting rebuilds it", () => {
    const before = fold([
      snapshot([entry(1, assistant("old"))]),
      { type: "run_start", inputs: [] } as AgentEvent,
    ]);
    const after = applyEvent(before, snapshot([entry(2, assistant("new"))]));
    expect(after.entries.map((e) => e.id)).toStrictEqual([2]);
    expect(after.running).toBeFalsy();
  });

  it("streams text deltas into the in-flight message, then commits it once", () => {
    const final = entry(5, assistant("Hello"));
    const state = fold([
      snapshot([]),
      { type: "run_start", inputs: [] } as AgentEvent,
      { type: "message_start", message: assistant("") } as AgentEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }],
      } as unknown as AgentEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
      } as unknown as AgentEvent,
    ]);
    expect(state.streaming?.content[0]).toStrictEqual({
      type: "text",
      text: "Hello",
    });

    // message_end and entry_appended carry the same entry; it is committed once.
    const committed = foldFrom(state, [
      { type: "message_end", entry: final } as AgentEvent,
      { type: "entry_appended", entry: final } as AgentEvent,
    ]);
    expect(committed.streaming).toBeUndefined();
    expect(committed.entries).toHaveLength(1);
  });

  it("tracks a tool's live output, trims and replacements included", () => {
    const state = fold([
      snapshot([]),
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
      } as AgentEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { append: "abc" },
      } as AgentEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { trimStart: 1, append: "d" },
        details: { conversationId: 7 },
      } as AgentEvent,
    ]);
    expect(state.tools.c1).toMatchObject({
      output: "bcd",
      status: "running",
      details: { conversationId: 7 },
    });
    const replaced = applyEvent(state, {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      output: { set: "fresh" },
    } as AgentEvent);
    expect(replaced.tools.c1?.output).toBe("fresh");

    const result = entry(9, {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "done" }],
    });
    const ended = applyEvent(replaced, {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      entry: result,
    } as AgentEvent);
    expect(ended.tools.c1?.status).toBe("done");
    expect(toolResultOf(ended, "c1")).toMatchObject({ role: "toolResult" });
  });

  it("records task failures and queued prompts", () => {
    const state = fold([
      snapshot([]),
      {
        type: "inbox_update",
        items: [{ id: 1, mode: "followUp" }],
      } as unknown as AgentEvent,
      {
        type: "task_failed",
        taskId: 3,
        kind: "pi.generation",
        message: "boom",
      } as unknown as AgentEvent,
    ]);
    expect(state.queued).toBe(1);
    expect(state.failures).toStrictEqual(["pi.generation: boom"]);
  });
});
