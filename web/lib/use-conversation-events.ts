"use client";

import { useEffect } from "react";

import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";
import { useConversationStore } from "./store";
import { subscribeToConversation } from "./subscribe";

/**
 * Subscribe to a conversation's events while mounted. Every (re)connection starts with a snapshot, which replaces the
 * state; a 404 marks the conversation ended instead of retrying.
 */
export const useConversationEvents = (
  id: number | undefined
): ConversationState => {
  const state = useConversationStore((store) =>
    id === undefined ? initialState : (store.byId[id] ?? initialState)
  );

  useEffect(() => {
    if (id === undefined) {
      return;
    }
    return subscribeToConversation(id);
  }, [id]);

  return state;
};
