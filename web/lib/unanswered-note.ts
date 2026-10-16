// The line the transcript shows under a user message whose run ended without an answer.
import type { UnansweredInput } from "effect-pi/api";

const REASONS: Readonly<Record<string, string>> = {
  no_model: "the conversation's model is not available",
  faulted: "the run failed",
  failed: "the run failed",
  stale: "it was left behind by an earlier run",
  reset: "the conversation was reset",
};

/** "Not answered: …"; `undefined` for a Stop, which the transcript already shows as stopped work. */
export const unansweredNote = (
  input: Pick<UnansweredInput, "reason" | "detail">
): string | undefined => {
  if (input.reason === "aborted") {
    return undefined;
  }
  const why =
    input.reason === "model_error" && typeof input.detail === "string"
      ? input.detail
      : (REASONS[input.reason] ?? input.reason);
  return `Not answered: ${why}`;
};
