import { describe, expect, it } from "vitest";

import { approvalOf } from "./approval";

describe(approvalOf, () => {
  it("reads pending and approved states", () => {
    const cases = [
      [
        { approval: "pending", approvalKey: "1:c1" },
        { state: "pending", key: "1:c1" },
      ],
      [{ approval: "approved" }, { state: "approved" }],
      [{ approval: "denied" }, { state: "denied" }],
      [{ approval: "pending" }, undefined],
      [{ ansi: "x" }, undefined],
      ["text", undefined],
      [undefined, undefined],
    ];
    expect(cases.map(([input]) => approvalOf(input))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});
