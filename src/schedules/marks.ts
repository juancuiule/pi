// How a fired message and its submission are marked, shared with web/ through the API (no runtime imports): the
// block a fired message leads with (format.ts writes it, web/lib/schedules.ts reads it) and the submission's requestId.

export const MARK_OPEN = "<scheduled_run ";
export const MARK_CLOSE = "</scheduled_run>";

/** A fired message's submission requestId: a re-fire after a crash is the same submission. */
export const scheduleRequestId = (id: string, due: number): string =>
  `schedule:${id}:${due}`;

/** Whether a submission's requestId says a schedule sent it — for run notifications ("scheduled run finished"). */
export const isScheduledRequest = (requestId?: string): boolean =>
  requestId?.startsWith("schedule:") === true;
