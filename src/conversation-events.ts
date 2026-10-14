// What a conversation's event stream carries: pi-durable's AgentEvents, with the snapshot extended by the inputs
// that were never answered. Only type imports: web/ gets these through `effect-pi/api`.
import type {
  AgentEvent,
  EntryId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

type Unanswered = Extract<SubmissionRecord, { status: "unanswered" }>;

/** A user message whose run ended without an answer, and why (pi-durable's `unanswered` reason and detail). */
export interface UnansweredInput {
  readonly entry: EntryId;
  readonly reason: string;
  readonly detail?: Unanswered["detail"];
}

/** The first event: pi-durable's snapshot, plus the conversation's unanswered inputs. */
export type ConversationSnapshot = Extract<AgentEvent, { type: "snapshot" }> & {
  readonly unanswered: readonly UnansweredInput[];
};

export type ConversationEvent =
  | Exclude<AgentEvent, { type: "snapshot" }>
  | ConversationSnapshot;
