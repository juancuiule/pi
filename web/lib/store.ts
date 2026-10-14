import type { AgentEvent, ConversationSummary } from "effect-pi/api";
import { create } from "zustand";

import { applyEvent, initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

interface Store {
  readonly byId: Readonly<Record<number, ConversationState>>;
  /** Conversations the server no longer knows (ended, swept, or lost in a restart). */
  readonly ended: Readonly<Record<number, true>>;
  /**
   * Resumes in flight, counted so a Resume action and a send (which resumes a paused Conversation first) can
   * overlap. The summary keeps saying "paused" until the new Seat exists, so the flag stands in for that gap.
   */
  readonly resuming: Readonly<Record<number, number>>;
  apply(id: number, event: AgentEvent): void;
  markEnded(id: number): void;
  beginResume(id: number): void;
  endResume(id: number): void;
}

export const useConversationStore = create<Store>()((set) => ({
  byId: {},
  ended: {},
  resuming: {},
  apply: (id, event) =>
    set((store) => {
      const byId = {
        ...store.byId,
        [id]: applyEvent(store.byId[id] ?? initialState, event),
      };
      // A snapshot means the server knows this id again: after a restart it can be a new conversation.
      if (event.type !== "snapshot" || store.ended[id] === undefined) {
        return { byId };
      }
      const { [id]: _cleared, ...ended } = store.ended;
      return { byId, ended };
    }),
  markEnded: (id) =>
    set((store) => ({ ended: { ...store.ended, [id]: true } })),
  beginResume: (id) =>
    set((store) => ({
      resuming: { ...store.resuming, [id]: (store.resuming[id] ?? 0) + 1 },
    })),
  endResume: (id) =>
    set((store) => {
      const count = store.resuming[id] ?? 0;
      if (count <= 1) {
        const { [id]: _done, ...resuming } = store.resuming;
        return { resuming };
      }
      return { resuming: { ...store.resuming, [id]: count - 1 } };
    }),
}));

/** True while `conversation` reads paused and a resume is in flight for it — the wait the resuming view covers. */
export const useResuming = (
  conversation: Pick<ConversationSummary, "id" | "status"> | undefined
): boolean =>
  useConversationStore(
    (store) =>
      conversation?.status === "paused" &&
      (store.resuming[conversation.id] ?? 0) > 0
  );
