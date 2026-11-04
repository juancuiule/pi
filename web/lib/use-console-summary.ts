// The favicon and page titles read all conversations' state from the same list the sidebar's dots do.
import { consoleSummaryOf } from "./conversation-status";
import type { ConsoleSummary } from "./conversation-status";
import { useConversations } from "./queries";
import { useConversationStore } from "./store";

export const useConsoleSummary = (): ConsoleSummary => {
  const { data } = useConversations();
  const ended = useConversationStore((store) => store.ended);
  return consoleSummaryOf(data ?? [], ended);
};
