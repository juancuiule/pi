// Whether a conversation's most recent settled input needs the person — the run's failure or the
// repeat guard's stop. Derived from submission records at read time; a newer settled input
// supersedes, so there is no flag to clear.
import type { SubmissionRecord } from "@earendil-works/pi-durable";

/** `unanswered` reasons that mean the run failed; every other reason means ended or lost. */
export const FAILED_SUBMISSION_REASONS = [
  "faulted",
  "model_error",
  "no_model",
] as const;
export type FailedSubmissionReason = (typeof FAILED_SUBMISSION_REASONS)[number];

/** Every Attention.reason: the failed submission reasons, plus the guard's kill. */
export const ATTENTION_REASONS = [
  ...FAILED_SUBMISSION_REASONS,
  "repeat_guard",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface Attention {
  readonly reason: AttentionReason;
  /** For a tooltip: the submission's `detail`, or the guard diagnostic's message. */
  readonly detail?: string;
}

export const isFailedReason = (
  reason: string
): reason is FailedSubmissionReason =>
  (FAILED_SUBMISSION_REASONS as readonly string[]).includes(reason);

/** The flag's subject: a settled input. Writes and queued/placed inputs never count. */
export const isSettledInput = (
  record: SubmissionRecord
): record is Extract<
  SubmissionRecord,
  { type: "input"; status: "done" | "unanswered" }
> =>
  record.type === "input" &&
  (record.status === "done" || record.status === "unanswered");

/** The Attention a settled record carries on its own; `done` needs the entry tail-scan the caller runs. */
export const recordAttention = (
  record: SubmissionRecord
): Attention | undefined => {
  if (
    !isSettledInput(record) ||
    record.status !== "unanswered" ||
    !isFailedReason(record.reason)
  ) {
    return undefined;
  }
  return {
    reason: record.reason,
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
  };
};
