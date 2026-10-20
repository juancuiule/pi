import type { ConversationSummary } from "effect-pi/api";

import { dotLabelOf, dotStatusOf } from "@/lib/conversation-status";
import type { DotStatus } from "@/lib/conversation-status";
import { cn } from "@/lib/utils";

const DOT_CLASS: Record<DotStatus, string> = {
  error: "bg-status-error rounded-xs",
  waiting: "bg-status-waiting rounded-full",
  live: "bg-status-live rounded-full",
  paused: "border-status-paused rounded-full border-2",
};

/**
 * The conversation's state as a small marker before its title in the sidebar: green while the Seat is up
 * (running or idle), yellow while it waits for a decision or answers, red when the server lost it or its
 * last run ended badly, gray when paused or archived. Shape repeats the state without color: error is a
 * square, paused an empty circle, the rest a filled circle. `title` gives a native tooltip; the label
 * repeats in sr-only text for screen readers.
 */
export const StatusDot = ({
  conversation,
  ended = false,
  resuming = false,
  className,
}: {
  conversation: Pick<
    ConversationSummary,
    "status" | "pendingApprovals" | "attention"
  >;
  /** The server's stream reported the conversation gone — the red reserved state. */
  ended?: boolean;
  /** A resume is in flight while the summary still reads paused. */
  resuming?: boolean;
  className?: string;
}) => {
  const label = dotLabelOf(conversation, ended, resuming);
  return (
    <>
      <span
        aria-hidden
        title={label}
        className={cn(
          "size-2 shrink-0",
          DOT_CLASS[dotStatusOf(conversation, ended)],
          className
        )}
      />
      <span className="sr-only">{label}</span>
    </>
  );
};
