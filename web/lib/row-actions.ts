// What a conversation row in the sidebar offers, by swipe and by its menu: Pin on the leading side, the Seat's
// lifecycle and Archive on the trailing side, the edge action of each side being its full swipe.
import type { ConversationSummary } from "effect-pi/api";

export type RowAction =
  | "pin"
  | "unpin"
  | "pause"
  | "resume"
  | "archive"
  | "unarchive";

export interface RowActions {
  /** Revealed by a left-to-right swipe; a full swipe runs it. */
  readonly leading: RowAction;
  /** Revealed by a right-to-left swipe, inner first; a full swipe runs the last, at the row's edge. */
  readonly trailing: readonly RowAction[];
}

/**
 * The actions a row offers in `conversation`'s state. Pause only while there is a Seat and no Pause waits; Resume
 * only when paused and not already resuming; an archived row offers Unarchive alone.
 */
export const rowActionsOf = (
  conversation: Pick<ConversationSummary, "status" | "pausing" | "pinnedAt">,
  resuming: boolean
): RowActions => {
  const leading = conversation.pinnedAt === undefined ? "pin" : "unpin";
  const { status } = conversation;
  if (status === "archived") {
    return { leading, trailing: ["unarchive"] };
  }
  const lifecycle: RowAction[] = [];
  if ((status === "running" || status === "idle") && !conversation.pausing) {
    lifecycle.push("pause");
  }
  if (status === "paused" && !resuming) {
    lifecycle.push("resume");
  }
  return { leading, trailing: [...lifecycle, "archive"] };
};

export const ROW_ACTION_LABEL: Record<RowAction, string> = {
  pin: "Pin",
  unpin: "Unpin",
  pause: "Pause",
  resume: "Resume",
  archive: "Archive",
  unarchive: "Unarchive",
};

/** Pinned first, the most recently pinned on top; then newest first. The server lists in this order too. */
export const byPinThenRecency = (
  a: Pick<ConversationSummary, "pinnedAt" | "createdAt">,
  b: Pick<ConversationSummary, "pinnedAt" | "createdAt">
): number => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt;
