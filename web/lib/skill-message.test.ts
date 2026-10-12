import { describe, expect, it } from "vitest";

import {
  parseSkillMessage,
  skillMentionParts,
  splitSkillHints,
} from "./skill-message";

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

describe(splitSkillHints, () => {
  it("drops the hints block and names its skills", () => {
    expect(
      splitSkillHints(
        [
          "use /skill:a and /skill:b-c",
          "",
          "<skill_hints>",
          "  <note>The user pointed at these skills.</note>",
          "  <skill>",
          "    <name>a</name>",
          "    <description>Does &lt;A&gt;.</description>",
          "  </skill>",
          "  <skill>",
          "    <name>b-c</name>",
          "    <description>Does B: really.</description>",
          "  </skill>",
          "</skill_hints>",
        ].join("\n")
      )
    ).toStrictEqual({
      text: "use /skill:a and /skill:b-c",
      hinted: ["a", "b-c"],
    });
  });

  it("leaves other messages alone", () => {
    expect(splitSkillHints("hello")).toStrictEqual({
      text: "hello",
      hinted: [],
    });
    expect(
      splitSkillHints(
        "quoted\n\n<skill_hints>\n  <name>a</name>\n</skill_hints>\n\nmore"
      )
    ).toStrictEqual({
      text: "quoted\n\n<skill_hints>\n  <name>a</name>\n</skill_hints>\n\nmore",
      hinted: [],
    });
  });
});

describe(skillMentionParts, () => {
  it("splits hinted mentions out of the text", () => {
    expect(
      skillMentionParts("/skill:a then /skill:nope, /skill:a.", ["a"])
    ).toStrictEqual([
      { kind: "skill", skill: "a" },
      { kind: "text", text: " then /skill:nope, " },
      { kind: "skill", skill: "a" },
      { kind: "text", text: "." },
    ]);
  });
});
