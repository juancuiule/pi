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
  withEarlierLoading,
  withEarlierPage,
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

const snapshot = (
  entries: EntryRecord[],
  running = false,
  earlier: number | false = false
): ConversationEvent =>
  ({
    type: "snapshot",
    entries,
    earlier,
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

/** An entry carrying a `head`, as a head marker (a compaction or reset) does. */
const head = (id: number): EntryRecord =>
  ({
    ...entry(id, { role: "user", content: "summary" }),
    head: id,
  }) as EntryRecord;

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

describe("earlier history", () => {
  it("a snapshot's `earlier` flags hidden history without fetching it", () => {
    const state = fold([snapshot([head(10)], false, 9)]);
    expect(state.earlier.hasMore).toBeTruthy();
    expect(state.earlier.entries).toStrictEqual([]);

    // A snapshot without hidden history — and reconnects — report none.
    expect(fold([snapshot([])]).earlier.hasMore).toBeFalsy();
  });

  it("folds a fetched page ahead of held entries, deduped, and clears loading", () => {
    const loaded = withEarlierPage(
      withEarlierLoading(fold([snapshot([head(10)], false, 9)]), true),
      {
        entries: [entry(8, assistant("eight")), entry(9, assistant("nine"))],
        earlier: true,
      }
    );
    expect(loaded.earlier.loading).toBeFalsy();
    expect(loaded.earlier.hasMore).toBeTruthy();
    expect(loaded.earlier.entries.map((e) => e.id)).toStrictEqual([8, 9]);

    // Paging deeper prepends the older page; an entry it repeats is not doubled.
    const deeper = withEarlierPage(loaded, {
      entries: [entry(6, assistant("six")), entry(8, assistant("eight"))],
      earlier: false,
    });
    expect(deeper.earlier.entries.map((e) => e.id)).toStrictEqual([6, 8, 9]);
    expect(deeper.earlier.hasMore).toBeFalsy();
  });

  it("moves entries a fresh head marker displaced into the earlier history, in order", () => {
    const loaded = fold([
      snapshot(
        [entry(5, assistant("five")), entry(6, assistant("six"))],
        false,
        4
      ),
    ]);
    const paged = withEarlierPage(loaded, {
      entries: [entry(2, assistant("two"))],
      earlier: true,
    });
    // A new snapshot after another compaction: entries 5 and 6 fell out of the active view.
    const marker = {
      ...entry(9, { role: "user", content: "s" }),
      head: 7,
    } as EntryRecord;
    const next = applyEvent(
      paged,
      snapshot(
        [marker, entry(7, assistant("seven")), entry(8, assistant("eight"))],
        false,
        6
      )
    );
    expect(next.entries.map((e) => e.id)).toStrictEqual([9, 7, 8]);
    expect(next.earlier.entries.map((e) => e.id)).toStrictEqual([2, 5, 6]);
    expect(next.earlier.hasMore).toBeTruthy();
    // The bound moved: the next fetch re-anchors at the top instead of paging under the displaced entries.
    expect(next.earlier.frontier).toBeUndefined();
  });

  it("keeps fetched earlier entries across a reconnect's snapshot", () => {
    const state = fold([snapshot([head(10)], false, 9)]);
    const loaded = withEarlierPage(state, {
      entries: [entry(8, assistant("eight"))],
      earlier: false,
    });
    const reconnected = applyEvent(loaded, snapshot([head(10)], false, 9));
    expect(reconnected.earlier.entries.map((e) => e.id)).toStrictEqual([8]);
    expect(reconnected.earlier.frontier).toBe(8);
    expect(reconnected.earlier.hasMore).toBeTruthy();
  });

  it("does not double entries a raced page shares with the active transcript", () => {
    // A second marker committed live (entries appended, no snapshot yet): the fetch bound moved server-side and
    // the page it returns overlaps entries the client still shows.
    const state = fold([
      snapshot(
        [
          head(15),
          entry(16, assistant("sixteen")),
          entry(17, assistant("seventeen")),
        ],
        false,
        14
      ),
    ]);
    const loaded = withEarlierPage(state, {
      entries: [
        entry(13, assistant("thirteen")),
        entry(16, assistant("sixteen")),
        entry(17, assistant("seventeen")),
      ],
      earlier: false,
    });
    // 16 and 17 stay in the active transcript — the page does not re-show them as history.
    expect(loaded.earlier.entries.map((e) => e.id)).toStrictEqual([13]);
    expect(loaded.earlier.frontier).toBe(13);
  });

  it("sorts displaced entries into fetched history even when a marker's id lands mid-list", () => {
    const state = fold([snapshot([head(10)], false, 9)]);
    const loaded = withEarlierPage(state, {
      entries: [entry(1, assistant("one")), entry(2, assistant("two"))],
      earlier: true,
    });
    // The next view: [marker(20, head=15), 15, 16] — the marker's id is newer than the retained entries', and
    // entries 15..16 remain, while nothing the client held is displaced.
    const marker = {
      ...entry(20, { role: "user", content: "s" }),
      head: 15,
    } as EntryRecord;
    const next = applyEvent(
      loaded,
      snapshot(
        [
          marker,
          entry(15, assistant("fifteen")),
          entry(16, assistant("sixteen")),
        ],
        false,
        14
      )
    );
    // The superseded marker is displaced too — and sorts after the fetched page by id, not before it.
    expect(next.earlier.entries.map((e) => e.id)).toStrictEqual([1, 2, 10]);
    expect(next.earlier.bound).toBe(14);
    expect(next.earlier.frontier).toBeUndefined();
  });

  it("resolves the tool result a paged-in call's entry carries", () => {
    const loaded = withEarlierPage(fold([snapshot([head(10)], false, 9)]), {
      entries: [
        entry(4, {
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "text", text: "done" }],
        }),
      ],
      earlier: false,
    });
    expect(toolResultOf(loaded, "c1")).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
    });
  });

  it("clears paged history when a snapshot reports nothing hidden", () => {
    const loaded = withEarlierPage(fold([snapshot([head(10)], false, 9)]), {
      entries: [entry(8, assistant("eight"))],
      earlier: false,
    });
    const next = applyEvent(loaded, snapshot([]));
    expect(next.earlier.entries).toStrictEqual([]);
    expect(next.earlier.bound).toBeFalsy();
    expect(next.earlier.hasMore).toBeFalsy();
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
