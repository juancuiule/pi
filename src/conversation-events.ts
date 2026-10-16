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

/** The first event: pi-durable's snapshot, plus whether earlier entries exist and the unanswered inputs. */
export type ConversationSnapshot = Extract<AgentEvent, { type: "snapshot" }> & {
  /** True when a head marker (a compaction or reset) hides entries; the history endpoint returns them. */
  readonly earlier: boolean;
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
