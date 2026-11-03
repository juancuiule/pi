// A conversation's status dot: the small circle the sidebar draws ahead of each title. Colors live in
// globals.css as --color-status-* tokens; labels here name the state for the tooltip and screen readers.

import type { AttentionReason, ConversationSummary } from "effect-pi/api";

/**
 * The state a status dot reads: the strongest signal wins — lost beats waiting, waiting beats live. `running` is
 * a `live` Seat with a Run going; the dot draws both alike (the row's spinner tells them apart), the favicon not.
 */
export type DotStatus = "error" | "waiting" | "running" | "live" | "paused";

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
  faulted: "Run failed",
  model_error: "Model error",
  no_model: "No model configured",
  repeat_guard: "Stopped a repeated call",
};

/** Without a Seat, so without a Sandbox to show. */
export const seatlessOf = (conversation: Pick<ConversationSummary, "status">) =>
  conversation.status === "paused" || conversation.status === "archived";

/**
 * `ended` marks a conversation the server no longer knows (swept or lost in a restart). `attention`
 * marks one whose last settled input ended badly — a failed run or the repeat guard's stop. `waiting`
 * covers anything blocked on the person — an approval decision or an unanswered `ask_user` form, both
 * counted by `pendingApprovals`. `running` is a Seat with a Run going, `live` one waiting for the next
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
  if (conversation.status === "running") {
    return "running";
  }
  return conversation.status === "paused" || conversation.status === "archived"
    ? "paused"
    : "live";
};

/** What the console's favicon and title show for all of the person's conversations at once. */
export type ConsoleStatus = "waiting" | "error" | "running" | "idle";

export interface ConsoleSummary {
  readonly status: ConsoleStatus;
  /** Conversations whose dot is `waiting` or `error`: the title's `(n)`. */
  readonly attention: number;
}

/**
 * The favicon and title's state, read from every conversation's dot (`dotStatusOf`, so both stay in step with
 * the sidebar). Archived ones are left out. Across conversations a wait beats a failure — it is the one the
 * person can act on now, and a failed run stays red until its next message — then running beats idle.
 */
export const consoleSummaryOf = (
  conversations: readonly Pick<
    ConversationSummary,
    "id" | "status" | "pendingApprovals" | "attention"
  >[],
  ended: Readonly<Record<number, boolean>> = {}
): ConsoleSummary => {
  const dots = conversations
    .filter((conversation) => conversation.status !== "archived")
    .map((conversation) =>
      dotStatusOf(conversation, ended[conversation.id] === true)
    );
  const has = (status: DotStatus) => dots.includes(status);
  let status: ConsoleStatus = "idle";
  if (has("waiting")) {
    status = "waiting";
  } else if (has("error")) {
    status = "error";
  } else if (has("running")) {
    status = "running";
  }
  return {
    status,
    attention: dots.filter((dot) => dot === "waiting" || dot === "error")
      .length,
  };
};

/** A page's title with the count of conversations that need the person ahead of it. */
export const titleWith = (title: string, summary: ConsoleSummary): string =>
  summary.attention > 0 ? `(${summary.attention}) ${title}` : title;

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
