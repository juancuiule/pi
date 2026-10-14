import type { UnansweredInput } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { unansweredNote } from "./unanswered-note";

describe(unansweredNote, () => {
  it("says why a message was not answered, and nothing for a Stop", () => {
    const inputs = [
      { entry: 1, reason: "no_model" },
      { entry: 2, reason: "model_error", detail: "429 Too Many Requests" },
      { entry: 3, reason: "something_new" },
      { entry: 4, reason: "aborted" },
    ] as unknown as UnansweredInput[];
    expect(inputs.map(unansweredNote)).toStrictEqual([
      "Not answered: the conversation's model is not available",
      "Not answered: 429 Too Many Requests",
      "Not answered: something_new",
      undefined,
    ]);
  });
});
