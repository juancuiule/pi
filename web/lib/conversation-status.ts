// A conversation's status dot: the small circle the sidebar draws ahead of each title. Colors live in
// globals.css as --color-status-* tokens; labels here name the state for the tooltip and screen readers.

import type { AttentionReason, ConversationSummary } from "effect-pi/api";

/** The state a status dot reads: the strongest signal wins — lost beats waiting, waiting beats live. */
export type DotStatus = "error" | "waiting" | "live" | "paused";

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  faulted: "Run failed",
  model_error: "Model error",
  no_model: "No model configured",
  repeat_guard: "Stopped a repeated call",
};

/**
 * `ended` marks a conversation the server no longer knows (swept or lost in a restart). `attention`
 * marks one whose last settled input ended badly — a failed run or the repeat guard's stop. `waiting`
 * covers anything blocked on the person — an approval decision or an unanswered `ask_user` form, both
 * counted by `pendingApprovals`. `live` is a Seat that exists: running or waiting for the next
 * message. Paused and archived share the gray; the subtitle text already says which.
 */
export const dotStatusOf = (
  conversation: Pick<
    ConversationSummary,
    "status" | "pendingApprovals" | "attention"
  >,
  ended = false
): DotStatus => {
  if (ended) {
    return "error";
  }
  if (conversation.attention !== undefined) {
    return "error";
  }
  if (conversation.pendingApprovals > 0) {
    return "waiting";
  }
  return conversation.status === "paused" || conversation.status === "archived"
    ? "paused"
    : "live";
};

const STATUS_LABEL: Record<ConversationSummary["status"], string> = {
  running: "Running",
  idle: "Idle",
  paused: "Paused",
  archived: "Archived",
};

/** The dot's tooltip and screen-reader name; a resume in flight reads "Resuming" ahead of "Paused". */
export const dotLabelOf = (
  conversation: Pick<
    ConversationSummary,
    "status" | "pendingApprovals" | "attention"
  >,
  ended = false,
  resuming = false
): string => {
  if (ended) {
    return "Unreachable";
  }
  if (conversation.attention !== undefined) {
    const label = ATTENTION_LABEL[conversation.attention.reason];
    return conversation.attention.detail === undefined
      ? label
      : `${label}: ${conversation.attention.detail}`;
  }
  if (conversation.pendingApprovals > 0) {
    return "Waiting for you";
  }
  return resuming && conversation.status === "paused"
    ? "Resuming"
    : STATUS_LABEL[conversation.status];
};
