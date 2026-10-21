import type {
  ConversationEvent,
  ConversationSummary,
  HistoryPage,
  SubmissionAck,
} from "effect-pi/api";
import { create } from "zustand";

import {
  applyEvent,
  initialState,
  withAck,
  withEarlierLoading,
  withEarlierPage,
  withoutPending,
  withPending,
} from "./conversation-state";
import type { ConversationState, PendingInput } from "./conversation-state";

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
  /** Conversations shown in the transcript's simple view: messages and final answers, details folded away. */
  readonly simpleView: Readonly<Record<number, true>>;
  apply(id: number, event: ConversationEvent): void;
  /** One stream chunk's events in a single update: a commit's events land together or not at all. */
  applyAll(id: number, events: Iterable<ConversationEvent>): void;
  markEnded(id: number): void;
  /** Show a message being sent; the submission carrying its requestId resolves it. */
  addPending(id: number, pending: PendingInput): void;
  /** The send failed: remove its pending message. */
  dropPending(id: number, requestId: string): void;
  /** The send's answer names the pending's submission — the `submission` event may already have. */
  ackPending(id: number, requestId: string, ack: SubmissionAck): void;
  /** A "Show earlier entries" request is in flight. */
  setEarlierLoading(id: number, loading: boolean): void;
  /** Fold a fetched history page into the conversation's earlier history. */
  addEarlierPage(id: number, page: HistoryPage): void;
  beginResume(id: number): void;
  endResume(id: number): void;
  toggleThinking(id: number): void;
  /** Switch `id`'s transcript between the full view and the simple one. */
  toggleSimple(id: number): void;
}

const update =
  (id: number, change: (state: ConversationState) => ConversationState) =>
  (store: Store) => {
    const state = store.byId[id] ?? initialState;
    const next = change(state);
    return next === state ? {} : { byId: { ...store.byId, [id]: next } };
  };

const applyBatch = (
  store: Store,
  id: number,
  events: Iterable<ConversationEvent>
) => {
  let state = store.byId[id] ?? initialState;
  let snapshot = false;
  for (const event of events) {
    state = applyEvent(state, event);
    snapshot ||= event.type === "snapshot";
  }
  const byId = { ...store.byId, [id]: state };
  // A snapshot means the server knows this id again: after a restart it can be a new conversation. Fetched earlier
  // pages could then be another conversation's — drop them rather than render them above the fresh view.
  if (!snapshot || store.ended[id] === undefined) {
    return { byId };
  }
  const { [id]: _cleared, ...ended } = store.ended;
  return {
    byId: { ...byId, [id]: { ...state, earlier: initialState.earlier } },
    ended,
  };
};

export const useConversationStore = create<Store>()((set) => ({
  byId: {},
  ended: {},
  resuming: {},
  hiddenThinking: {},
  simpleView: {},
  apply: (id, event) => set((store) => applyBatch(store, id, [event])),
  applyAll: (id, events) => set((store) => applyBatch(store, id, events)),
  markEnded: (id) =>
    set((store) => ({ ended: { ...store.ended, [id]: true } })),
  addPending: (id, pending) =>
    set(update(id, (state) => withPending(state, pending))),
  dropPending: (id, requestId) =>
    set(update(id, (state) => withoutPending(state, requestId))),
  ackPending: (id, requestId, ack) =>
    set(update(id, (state) => withAck(state, requestId, ack))),
  setEarlierLoading: (id, loading) =>
    set(update(id, (state) => withEarlierLoading(state, loading))),
  addEarlierPage: (id, page) =>
    set(update(id, (state) => withEarlierPage(state, page))),
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
  toggleSimple: (id) =>
    set((store) => {
      if (store.simpleView[id] === true) {
        const { [id]: _full, ...simpleView } = store.simpleView;
        return { simpleView };
      }
      return { simpleView: { ...store.simpleView, [id]: true } };
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

/** True while `id`'s transcript shows the simple view. */
export const useSimpleView = (id: number): boolean =>
  useConversationStore((store) => store.simpleView[id] === true);
