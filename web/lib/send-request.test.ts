import { describe, expect, it } from "vitest";

import { requestIdForSend } from "./send-request";

describe(requestIdForSend, () => {
  const failed = { requestId: "req-1", text: "hi", attachments: ["att_a"] };

  it("reuses a failed send's requestId only for the same message", () => {
    expect(requestIdForSend(failed, "hi", ["att_a"])).toBe("req-1");
    // Edited text, a different file set, or no prior failure all mint a new id.
    expect(requestIdForSend(failed, "hi!", ["att_a"])).not.toBe("req-1");
    expect(requestIdForSend(failed, "hi", [])).not.toBe("req-1");
    expect(requestIdForSend(failed, "hi", ["att_b"])).not.toBe("req-1");
    expect(requestIdForSend(null, "hi", ["att_a"])).not.toBe("req-1");
  });
});
