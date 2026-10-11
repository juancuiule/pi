import type { AgentEvent } from "effect-pi/api";
import { create } from "zustand";

import { applyEvent, initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

interface Store {
  readonly byId: Readonly<Record<number, ConversationState>>;
  /** Conversations the server no longer knows (ended, swept, or lost in a restart). */
  readonly ended: Readonly<Record<number, true>>;
  apply(id: number, event: AgentEvent): void;
  markEnded(id: number): void;
}

export const useConversationStore = create<Store>()((set) => ({
  byId: {},
  ended: {},
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
}));
