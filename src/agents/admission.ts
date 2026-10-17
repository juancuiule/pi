// Submission admission for `Seat.send`, inside the caller's commit. pi-durable's `admitSubmission`
// (repos/pi/packages/durable/src/harness/submissions.ts) is not exported, so its busy branch is mirrored here
// over `Tx`; `Tx.createSubmission` documents this caller-implemented admission. The idle path stays with
// `Conversation.submit`, which owns the boundary work (`prepareBoundary`/`applyBoundary` are not exported either).
import { copyJson } from "@earendil-works/chord";
import type { JsonRepresentation } from "@earendil-works/chord";
import type {
  ConversationId,
  SubmissionId,
  Tx,
  UserInput,
} from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";

import { ApprovalDoc, waitingOnPerson } from "../approvals.ts";

/**
 * `admitSubmission`'s busy branch for an input, in the same order: requestId dedup, the live check, then the
 * submission and its inbox item. The queue mode is decided from committed state in this commit: a run waiting on
 * a person (an approval or `ask_user` card) gets `steer`, so it is placed at the next post-tools boundary; any
 * other busy run gets `followUp`. Returns "idle" when nothing runs, for the caller to delegate to
 * `Conversation.submit`. `submissionByRequest` is a table read, so it precedes `createSubmission`'s write.
 */
export const queueIfBusy = async (
  tx: Tx,
  conversationId: ConversationId,
  content: UserInput,
  requestId?: string
): Promise<SubmissionId | "idle"> => {
  if (requestId !== undefined) {
    const existing = await tx.submissionByRequest(conversationId, requestId);
    if (existing !== undefined) {
      if (existing.type !== "input") {
        throw new Error(
          `Request ${requestId} already identifies a submission of type ${existing.type}`
        );
      }
      return existing.id;
    }
  }
  const live = await tx.doc(LiveDoc, conversationId);
  if (live.run === undefined) {
    return "idle";
  }
  const approvals = await tx.doc(ApprovalDoc, conversationId);
  const mode = waitingOnPerson(approvals) ? "steer" : "followUp";
  const { id } = await tx.createSubmission({
    conversationId,
    ...(requestId === undefined ? {} : { requestId }),
    type: "input",
    status: "queued",
  });
  // Hosts may leave optional fields `undefined`; drafts take strict JSON.
  const inbox = await tx.doc(InboxDoc, conversationId);
  inbox.items.push({
    id,
    mode,
    content: copyJson(content, {
      omitUndefinedProperties: true,
    }) as JsonRepresentation<UserInput>,
  });
  return id;
};

/**
 * Re-decide a queued input's mode from committed approval state: a send delegated to `Conversation.submit` while
 * idle can have queued just as the run parked on a card, leaving a `followUp` where the wait asks `steer`. An item
 * already placed, or a passive write, keeps what it has.
 */
export const redecideQueuedMode = async (
  tx: Tx,
  conversationId: ConversationId,
  submissionId: SubmissionId
): Promise<void> => {
  const inbox = await tx.doc(InboxDoc, conversationId);
  const item = inbox.items.find((each) => each.id === submissionId);
  if (item === undefined || item.mode === "write") {
    return;
  }
  const approvals = await tx.doc(ApprovalDoc, conversationId);
  const mode = waitingOnPerson(approvals) ? "steer" : "followUp";
  if (item.mode !== mode) {
    item.mode = mode;
  }
};
