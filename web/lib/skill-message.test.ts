import { describe, expect, it } from "vitest";

import { parseSkillMessage } from "./skill-message";

describe(parseSkillMessage, () => {
  it("splits the skill block from the request", () => {
    expect(
      parseSkillMessage(
        '<skill name="repo-report">\n# Report\nDo it.\n</skill>\n\nreport this repo'
      )
    ).toStrictEqual({
      skill: "repo-report",
      instructions: "# Report\nDo it.",
      request: "report this repo",
    });
  });

  it("accepts a block with no request", () => {
    expect(parseSkillMessage('<skill name="x">\nbody\n</skill>')).toStrictEqual(
      { skill: "x", instructions: "body", request: "" }
    );
  });

  it("keeps a closing tag inside the instructions", () => {
    const text =
      '<skill name="x">\nWrite </skill> literally:\n</skill>\n\nnot the end\n</skill>\n\nreal request';
    expect(parseSkillMessage(text)).toStrictEqual({
      skill: "x",
      instructions: "Write </skill> literally:\n</skill>\n\nnot the end",
      request: "real request",
    });
  });

  it("ignores ordinary messages", () => {
    expect(parseSkillMessage("hello")).toBeUndefined();
    expect(
      parseSkillMessage('say <skill name="x">\nhi\n</skill>')
    ).toBeUndefined();
    expect(parseSkillMessage('<skill name="x">\nunterminated')).toBeUndefined();
  });
});
