import type { Context as ChordContext } from "@earendil-works/chord";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  EntryId,
  Storage,
  SubmissionRecord,
  ToolDiagnostic,
} from "@earendil-works/pi-durable";

import type { Attention } from "../attention.ts";
import { isSettledInput, recordAttention } from "../attention.ts";
import { REPEAT_GUARD_CODE } from "../repeat-guard.ts";

const SUBMISSIONS_PAGE = 32;
const TAIL_PAGE = 64;

type SettledInput = Extract<
  SubmissionRecord,
  { type: "input"; status: "done" | "unanswered" }
>;

/** Kinds that close a killed run's tail: a newer turn or context began after `answer`. */
const TURN_BOUNDARY: ReadonlySet<string> = new Set([
  "pi.user",
  "pi.assistant",
  "pi.reset",
]);

const lastSettledInput = async (
  storage: Storage,
  id: ConversationId,
  context: ChordContext,
  cursor?: Cursor
): Promise<SettledInput | undefined> => {
  const page = await storage.scanSubmissions(
    { conversationId: id, order: "descending" },
    SUBMISSIONS_PAGE,
    cursor,
    context
  );
  return (
    page.items.find(isSettledInput) ??
    (page.next === undefined
      ? undefined
      : lastSettledInput(storage, id, context, page.next))
  );
};

const guardDiagnostic = (diagnostics: readonly ToolDiagnostic[] | undefined) =>
  diagnostics?.find(
    (d) => d.severity === "error" && d.code === REPEAT_GUARD_CODE
  );

// A guard-killed run settles `done` with `answer` = the final round's pi.assistant; the round's
// flagged pi.tool-result entries hold ids in (answer, next turn's first entry). Ascending from
// answer+1, stop at the first turn-boundary kind — a kill's diagnostics precede it.
const guardKillAfter = async (
  storage: Storage,
  id: ConversationId,
  answer: EntryId,
  context: ChordContext,
  cursor?: Cursor
): Promise<Attention | undefined> => {
  const page = await storage.scanEntries(
    {
      conversationId: id,
      minEntryId: (Number(answer) + 1) as EntryId,
      order: "ascending",
    },
    TAIL_PAGE,
    cursor,
    context
  );
  for (const entry of page.items) {
    if (TURN_BOUNDARY.has(entry.kind)) {
      return undefined;
    }
    if (!ToolResultEntry.is(entry)) {
      continue;
    }
    const hit = guardDiagnostic(entry.data?.diagnostics);
    if (hit !== undefined) {
      return { reason: "repeat_guard", detail: hit.message };
    }
  }
  return page.next === undefined
    ? undefined
    : guardKillAfter(storage, id, answer, context, page.next);
};

/** Why `id`'s most recent settled input needs the person, if it ended badly. Two reads at most. */
export const attentionOf = async (
  storage: Storage,
  id: ConversationId,
  context: ChordContext
): Promise<Attention | undefined> => {
  const last = await lastSettledInput(storage, id, context);
  if (last === undefined) {
    return undefined;
  }
  return last.status === "done"
    ? guardKillAfter(storage, id, last.answer, context)
    : recordAttention(last);
};
