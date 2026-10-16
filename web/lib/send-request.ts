/** A send that failed after its requestId went out: the same message sent again reuses it. */
export interface FailedSend {
  readonly requestId: string;
  readonly text: string;
  readonly attachments: readonly string[];
}

/**
 * A send's requestId. The failed send's when the message is unchanged — a send that errored may already be
 * admitted server-side, and resubmitting under its id answers with that submission instead of a duplicate —
 * and a fresh one otherwise, so a repeated message is a new submission.
 */
export const requestIdForSend = (
  failed: FailedSend | null,
  text: string,
  attachments: readonly string[]
): string =>
  failed !== null &&
  failed.text === text &&
  failed.attachments.length === attachments.length &&
  failed.attachments.every((id, index) => id === attachments[index])
    ? failed.requestId
    : crypto.randomUUID();
