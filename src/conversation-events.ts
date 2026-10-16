// What a conversation's event stream carries: pi-durable's AgentEvents, with the snapshot extended by the inputs
// that were never answered. Only type imports: web/ gets these through `effect-pi/api`.
import type {
  AgentEvent,
  EntryId,
  EntryRecord,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

type Unanswered = Extract<SubmissionRecord, { status: "unanswered" }>;

/** A user message whose run ended without an answer, and why (pi-durable's `unanswered` reason and detail). */
export interface UnansweredInput {
  readonly entry: EntryId;
  readonly reason: string;
  readonly detail?: Unanswered["detail"];
}

/** The first event: pi-durable's snapshot, plus the hidden-history bound and the unanswered inputs. */
export type ConversationSnapshot = Extract<AgentEvent, { type: "snapshot" }> & {
  /**
   * The newest entry id a head marker (a compaction or reset) hides — the earlier-history bound — or false when
   * nothing is hidden; the history endpoint pages the range ending at it. A higher value than the last snapshot's
   * means a new marker landed and fetched pages should re-anchor at the top.
   */
  readonly earlier: number | false;
  readonly unanswered: readonly UnansweredInput[];
};

/** One page of transcript entries from before the active context, oldest first; `earlier` when more exist before them. */
export interface HistoryPage {
  readonly entries: readonly EntryRecord[];
  readonly earlier: boolean;
}

export type ConversationEvent =
  | Exclude<AgentEvent, { type: "snapshot" }>
  | ConversationSnapshot;
