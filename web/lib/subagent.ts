import type { EntryRecord } from "effect-pi/api";

import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

/** The child conversation id a `task` call reports in its `details`. */
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
): number | undefined =>
  subagentIdOf(state.tools[callId]?.details) ??
  subagentIdOf(toolResultOf(state, callId)?.details);

/** `task` calls still in flight: each is a subagent at work. */
export const activeSubagents = (state: ConversationState): number =>
  Object.values(state.tools).filter(
    (tool) => tool.name === "task" && tool.status !== "done"
  ).length;

/** Child ids of the `task` calls among `entries` still in flight: their children may be waiting on the person. */
export const subagentsInFlight = (
  entries: readonly EntryRecord[],
  state: ConversationState
): readonly number[] =>
  entries
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .flatMap((block) =>
      block.type === "toolCall" &&
      block.name === "task" &&
      state.tools[block.id]?.status !== "done" &&
      toolResultOf(state, block.id) === undefined
        ? (subagentIdFor(state, block.id) ?? [])
        : []
    );
