import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

/** The child conversation id a `subagent` tool reports in its `details`. */
export const subagentIdOf = (details?: unknown): number | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const id = (details as { conversationId?: unknown }).conversationId;
  return typeof id === "number" && Number.isInteger(id) ? id : undefined;
};

/** Live tool details first; once the tool finishes the slot's details are gone, so fall back to the committed result. */
export const subagentIdFor = (
  state: ConversationState,
  callId: string
): number | undefined => {
  const live = subagentIdOf(state.tools[callId]?.details);
  if (live !== undefined) {
    return live;
  }
  const result = toolResultOf(state, callId);
  return result?.role === "toolResult"
    ? subagentIdOf(result.details)
    : undefined;
};
