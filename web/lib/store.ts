import type { ConversationEvent, ConversationSummary } from "effect-pi/api";
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
  /** Conversations whose thinking steps the person chose to hide in the transcript. */
  readonly hiddenThinking: Readonly<Record<number, true>>;
  apply(id: number, event: ConversationEvent): void;
  markEnded(id: number): void;
  beginResume(id: number): void;
  endResume(id: number): void;
  toggleThinking(id: number): void;
}

export const useConversationStore = create<Store>()((set) => ({
  byId: {},
  ended: {},
  resuming: {},
  hiddenThinking: {},
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
  toggleThinking: (id) =>
    set((store) => {
      if (store.hiddenThinking[id] === true) {
        const { [id]: _shown, ...hiddenThinking } = store.hiddenThinking;
        return { hiddenThinking };
      }
      return { hiddenThinking: { ...store.hiddenThinking, [id]: true } };
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

/** True while `id`'s thinking steps are hidden in its transcript. */
export const useThinkingHidden = (id: number): boolean =>
  useConversationStore((store) => store.hiddenThinking[id] === true);
