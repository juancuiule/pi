import type { ConversationEvent } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { useConversationStore } from "./store";

const snapshot = {
  type: "snapshot",
  entries: [],
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
});
