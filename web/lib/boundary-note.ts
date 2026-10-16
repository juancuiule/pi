// What a head-marked entry (a compaction or reset) shows in the transcript: a boundary line, not the user
// message its `model` happens to carry. Pure, so it is unit-tested; the export builder shares it.
import type { EntryRecord, Message } from "effect-pi/api";

import { userParts } from "./transcript";

// pi-durable writes a compaction summary as a user message with this fixed wrapper; the console shows the
// summary, not the markup.
const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export interface BoundaryNote {
  readonly kind: "compaction" | "reset" | "boundary";
  /** The row's label, e.g. "Context compacted (threshold)". */
  readonly title: string;
  /** A compaction's `data.reason`, when it carried one. */
  readonly reason?: string;
  /** The summary or handoff text, without its model-facing wrapper; "" when the entry carries none. */
  readonly body: string;
}

/** The text of a head marker's user message, when it carries one. */
const markerText = (entry: EntryRecord): string => {
  const message = entry.model?.find(
    (m): m is Extract<Message, { role: "user" }> => m.role === "user"
  );
  return message === undefined ? "" : userParts(message).text;
};

/** `text` without `prefix…suffix`, or as written when the wrapper is absent (a hand-authored entry). */
const unwrapped = (text: string, prefix: string, suffix: string): string =>
  text.startsWith(prefix) && text.endsWith(suffix)
    ? text.slice(prefix.length, text.length - suffix.length)
    : text;

/** A head-marked entry's boundary note; `undefined` for ordinary entries. */
export const boundaryNote = (entry: EntryRecord): BoundaryNote | undefined => {
  if (entry.head === undefined) {
    return undefined;
  }
  switch (entry.kind) {
    case "pi.compaction": {
      const data = entry.data as { readonly reason?: unknown } | undefined;
      const reason = typeof data?.reason === "string" ? data.reason : undefined;
      return {
        kind: "compaction",
        title:
          reason === undefined
            ? "Context compacted"
            : `Context compacted (${reason})`,
        ...(reason === undefined ? {} : { reason }),
        body: unwrapped(markerText(entry), SUMMARY_PREFIX, SUMMARY_SUFFIX),
      };
    }
    case "pi.reset": {
      return {
        kind: "reset",
        title: "Conversation reset",
        body: markerText(entry),
      };
    }
    default: {
      return { kind: "boundary", title: entry.kind, body: markerText(entry) };
    }
  }
};
