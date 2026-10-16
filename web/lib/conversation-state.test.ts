import type {
  ConversationEvent,
  AssistantMessage,
  EntryRecord,
} from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  applyEvent,
  initialState,
  toolResultOf,
  withAck,
  withoutPending,
  withPending,
} from "./conversation-state";
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

const snapshot = (entries: EntryRecord[], running = false): ConversationEvent =>
  ({
    type: "snapshot",
    entries,
    ...(running ? { run: { inputs: [] } } : {}),
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
    unanswered: [],
  }) as unknown as ConversationEvent;

/** pi-durable's event for an input that settled without an answer. */
const unansweredEvent = (id: number, reason: string): ConversationEvent =>
  ({
    type: "submission",
    record: {
      id: id + 1,
      conversationId: 1,
      type: "input",
      status: "unanswered",
      entry: id,
      reason,
    },
  }) as unknown as ConversationEvent;

const foldFrom = (start: ConversationState, events: ConversationEvent[]) => {
  let state = start;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
};
const fold = (events: ConversationEvent[]) => foldFrom(initialState, events);

describe(applyEvent, () => {
  it("a snapshot replaces all state, so reconnecting rebuilds it", () => {
    const before = fold([
      snapshot([entry(1, assistant("old"))]),
      { type: "run_start", inputs: [] } as ConversationEvent,
    ]);
    const after = applyEvent(before, snapshot([entry(2, assistant("new"))]));
    expect(after.entries.map((e) => e.id)).toStrictEqual([2]);
    expect(after.running).toBeFalsy();
  });

  it("is hydrated once a snapshot lands", () => {
    expect(initialState.hydrated).toBeFalsy();
    expect(fold([snapshot([])]).hydrated).toBeTruthy();
  });

  it("streams text deltas into the in-flight message, then commits it once", () => {
    const final = entry(5, assistant("Hello"));
    const state = fold([
      snapshot([]),
      { type: "run_start", inputs: [] } as ConversationEvent,
      { type: "message_start", message: assistant("") } as ConversationEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }],
      } as unknown as ConversationEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
      } as unknown as ConversationEvent,
    ]);
    expect(state.streaming?.content[0]).toStrictEqual({
      type: "text",
      text: "Hello",
    });

    // message_end and entry_appended carry the same entry; it is committed once.
    const committed = foldFrom(state, [
      { type: "message_end", entry: final } as ConversationEvent,
      { type: "entry_appended", entry: final } as ConversationEvent,
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
      } as ConversationEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { append: "abc" },
      } as ConversationEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { trimStart: 1, append: "d" },
        details: { conversationId: 7 },
      } as ConversationEvent,
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
    } as ConversationEvent);
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
    } as ConversationEvent);
    expect(ended.tools.c1?.status).toBe("done");
    expect(toolResultOf(ended, "c1")).toMatchObject({ role: "toolResult" });
  });

  it("records task failures and queued prompts", () => {
    const state = fold([
      snapshot([]),
      {
        type: "inbox_update",
        items: [{ id: 1, mode: "followUp" }],
      } as unknown as ConversationEvent,
      {
        type: "task_failed",
        taskId: 3,
        kind: "pi.generation",
        message: "boom",
      } as unknown as ConversationEvent,
    ]);
    expect(state.queued).toBe(1);
    expect(state.failures).toStrictEqual(["pi.generation: boom"]);
  });

  it("keeps the inputs that were never answered, from the snapshot and as they settle", () => {
    const state = fold([
      {
        ...(snapshot([]) as object),
        unanswered: [{ entry: 4, reason: "no_model" }],
      } as unknown as ConversationEvent,
      unansweredEvent(9, "model_error"),
      {
        type: "submission",
        record: {
          id: 12,
          conversationId: 1,
          type: "input",
          status: "placed",
          entry: 11,
        },
      } as unknown as ConversationEvent,
    ]);
    expect(state.unanswered).toStrictEqual({
      4: { entry: 4, reason: "no_model" },
      9: { entry: 9, reason: "model_error" },
    });
  });
});

const submission = (
  status: "queued" | "placed",
  placedEntry?: number
): ConversationEvent =>
  ({
    type: "submission",
    record: {
      id: 7,
      conversationId: 1,
      type: "input",
      requestId: "r1",
      status,
      ...(placedEntry === undefined ? {} : { entry: placedEntry }),
    },
  }) as unknown as ConversationEvent;

// Issue #16: a sent message shows as pending until its submission's entry replaces it — never rendered twice.
describe("pending inputs", () => {
  const pending = { requestId: "r1", prompt: "Hi", attachments: [] };
  const userEntry = entry(12, {
    role: "user",
    content: [{ type: "text", text: "Hi" }],
  });

  it("confirms a sent message, then replaces its bubble with the entry — once", () => {
    const sent = withPending(initialState, pending);
    // The `submission` event names it: no longer "Sending…", still a bubble.
    const confirmed = foldFrom(sent, [submission("queued")]);
    expect(confirmed.pending).toStrictEqual([{ ...pending, submission: 7 }]);

    // Placed, then the entry lands: the pending is gone before it could render twice.
    const placed = foldFrom(confirmed, [
      submission("placed", 12),
      { type: "entry_appended", entry: userEntry } as ConversationEvent,
    ]);
    expect(placed.pending).toStrictEqual([]);
    expect(placed.entries.map((e) => e.id)).toStrictEqual([12]);
  });

  it("drops the pending when its entry wins the race to the transcript", () => {
    // entry_appended before the `submission` event: the bubble still goes away exactly once.
    const state = foldFrom(withPending(initialState, pending), [
      { type: "entry_appended", entry: userEntry } as ConversationEvent,
      submission("placed", 12),
    ]);
    expect(state.pending).toStrictEqual([]);
    expect(state.entries.map((e) => e.id)).toStrictEqual([12]);
  });

  it("drops the pending when its submission settles unanswered", () => {
    const state = foldFrom(withPending(initialState, pending), [
      submission("placed", 12),
      {
        type: "submission",
        record: {
          id: 7,
          conversationId: 1,
          type: "input",
          requestId: "r1",
          status: "unanswered",
          entry: 12,
          reason: "model_error",
        },
      } as unknown as ConversationEvent,
    ]);
    expect(state.pending).toStrictEqual([]);
    expect(state.unanswered[12]?.reason).toBe("model_error");
  });

  it("keeps an unconfirmed or queued pending over a snapshot, drops a placed one", () => {
    // A snapshot that knows nothing of it yet keeps the bubble.
    const kept = applyEvent(withPending(initialState, pending), snapshot([]));
    expect(kept.pending).toStrictEqual([pending]);

    // Queued in the fresh inbox, it survives…
    const queued = { ...pending, submission: 7 };
    const inInbox = applyEvent({ ...initialState, pending: [queued] }, {
      ...(snapshot([]) as object),
      inbox: [{ id: 7 }],
    } as unknown as ConversationEvent);
    expect(inInbox.pending).toStrictEqual([queued]);

    // …placed and in the snapshot's entries, the entry shows instead of it.
    const placed = applyEvent(
      { ...initialState, pending: [{ ...queued, entry: 12 }] },
      snapshot([userEntry])
    );
    expect(placed.pending).toStrictEqual([]);
    expect(placed.entries.map((e) => e.id)).toStrictEqual([12]);
  });

  it("the send's answer confirms a pending its event has not carried yet", () => {
    const acked = withAck(withPending(initialState, pending), "r1", {
      id: 7,
      status: "queued",
    });
    expect(acked.pending).toStrictEqual([{ ...pending, submission: 7 }]);
    // A placed ack whose entry is already committed drops it at once.
    const placed = withAck(acked, "r1", { id: 7, status: "placed", entry: 12 });
    expect(placed.pending[0]?.entry).toBe(12);
    const gone = withAck(
      { ...initialState, entries: [userEntry], pending: [pending] },
      "r1",
      { id: 7, status: "placed", entry: 12 }
    );
    expect(gone.pending).toStrictEqual([]);
  });

  it("an ack for a submission that already settled unanswered drops the pending with its note", () => {
    // The send's answer can carry an `unanswered` record when a retried request names one.
    const next = withAck(withPending(initialState, pending), "r1", {
      id: 7,
      status: "unanswered",
      reason: "aborted",
    });
    expect(next.pending).toStrictEqual([]);
    expect(next.failures).toStrictEqual(["Not sent: the run was stopped"]);
  });

  it("says why a queued send's bubble vanished when the run stopped before placing it", () => {
    const state = foldFrom(withPending(initialState, pending), [
      submission("queued"),
      // Stopped while queued: settles unanswered with no entry — nothing shows why the bubble is gone.
      {
        type: "submission",
        record: {
          id: 7,
          conversationId: 1,
          type: "input",
          requestId: "r1",
          status: "unanswered",
          reason: "aborted",
        },
      } as unknown as ConversationEvent,
    ]);
    expect(state.pending).toStrictEqual([]);
    expect(state.failures).toStrictEqual(["Not sent: the run was stopped"]);
  });

  it("a failed send drops the pending so the composer can restore it", () => {
    const sent = withPending(initialState, pending);
    expect(withoutPending(sent, "r1").pending).toStrictEqual([]);
    // An unknown requestId leaves the rest alone.
    expect(
      withoutPending(withPending(sent, { ...pending, requestId: "r2" }), "rx")
        .pending
    ).toHaveLength(2);
  });
});
