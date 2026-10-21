import type { ConversationEvent, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { useConversationStore } from "./store";

const snapshot = {
  type: "snapshot",
  entries: [],
  earlier: false,
  tools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  unanswered: [],
} as unknown as ConversationEvent;

const runEnd = { type: "run_end" } as unknown as ConversationEvent;

describe(useConversationStore, () => {
  it("clears an ended id when a snapshot arrives for it, as after a server restart reuses the id", () => {
    const store = useConversationStore.getState();
    store.markEnded(2);
    store.markEnded(3);

    store.apply(2, runEnd);
    expect(useConversationStore.getState().ended[2]).toBeTruthy();

    store.apply(2, snapshot);
    expect(useConversationStore.getState().ended[2]).toBeUndefined();
    expect(useConversationStore.getState().ended[3]).toBeTruthy();
  });

  it("counts overlapping resumes, so one settling cannot clear the other's wait; stray ends are no-ops", () => {
    const store = useConversationStore.getState();
    store.beginResume(5);
    store.beginResume(5);
    store.beginResume(6);

    store.endResume(5);
    expect(useConversationStore.getState().resuming[5]).toBe(1);

    store.endResume(5);
    store.endResume(5);
    expect(useConversationStore.getState().resuming[5]).toBeUndefined();
    expect(useConversationStore.getState().resuming[6]).toBe(1);
  });

  it("applies one stream chunk's events in a single update, so a commit lands atomically", () => {
    const store = useConversationStore.getState();
    let notifications = 0;
    const unsubscribe = useConversationStore.subscribe(() => {
      notifications += 1;
    });
    store.applyAll(9, [
      { type: "run_start" } as ConversationEvent,
      { type: "run_end" } as ConversationEvent,
    ]);
    unsubscribe();
    expect(notifications).toBe(1);
    expect(useConversationStore.getState().byId[9]?.running).toBeFalsy();
  });

  it("folds a fetched history page into a conversation's earlier slice", () => {
    const store = useConversationStore.getState();
    store.setEarlierLoading(11, true);
    expect(
      useConversationStore.getState().byId[11]?.earlier.loading
    ).toBeTruthy();

    const entry = { id: 3, conversationId: 1, kind: "pi.user" } as EntryRecord;
    store.addEarlierPage(11, { entries: [entry], earlier: false });
    const earlier = useConversationStore.getState().byId[11]?.earlier;
    expect(earlier?.entries.map((e) => e.id)).toStrictEqual([3]);
    expect(earlier?.hasMore).toBeFalsy();
    expect(earlier?.loading).toBeFalsy();
  });

  it("toggles a conversation's thinking visibility, per conversation", () => {
    const store = useConversationStore.getState();
    store.toggleThinking(7);
    store.toggleThinking(8);
    expect(useConversationStore.getState().hiddenThinking[7]).toBeTruthy();

    store.toggleThinking(7);
    expect(useConversationStore.getState().hiddenThinking[7]).toBeUndefined();
    expect(useConversationStore.getState().hiddenThinking[8]).toBeTruthy();

    store.toggleThinking(8);
    expect(useConversationStore.getState().hiddenThinking[8]).toBeUndefined();
  });

  it("toggles a conversation's simple view, per conversation", () => {
    const store = useConversationStore.getState();
    store.toggleSimple(13);
    store.toggleSimple(14);
    expect(useConversationStore.getState().simpleView[13]).toBeTruthy();

    store.toggleSimple(13);
    expect(useConversationStore.getState().simpleView[13]).toBeUndefined();
    expect(useConversationStore.getState().simpleView[14]).toBeTruthy();

    store.toggleSimple(14);
    expect(useConversationStore.getState().simpleView[14]).toBeUndefined();
  });
});
