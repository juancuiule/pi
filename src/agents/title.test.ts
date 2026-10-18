import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import {
  capTitle,
  cleanTitle,
  TITLE_CAP,
  titleMessages,
  titleText,
} from "./title.ts";

describe(cleanTitle, () => {
  it("takes the first line, trims, and collapses whitespace", () => {
    const cases: [string, string | undefined][] = [
      ["  a\nb c  ", "a"],
      ["first\n\n\nthird", "first"],
      ["many   spaces", "many spaces"],
      ["tab\tseparated", "tab separated"],
      ["", undefined],
      ["   \n next", undefined],
      ['"A quoted title"', "A quoted title"],
      ["'A quoted title'", "A quoted title"],
      ["«A quoted title»", "A quoted title"],
      ["“A quoted title”", "A quoted title"],
      ["’A quoted title’", "A quoted title"],
      ['"quoted", said it', 'quoted", said it'],
      ["An emoji ✨ is kept", "An emoji ✨ is kept"],
    ];
    expect(cases.map(([input]) => cleanTitle(input))).toStrictEqual(
      cases.map(([, expected]) => expected)
    );
  });
});

describe(capTitle, () => {
  it("keeps titles at the cap and ends longer ones with an ellipsis", () => {
    const at = "x".repeat(TITLE_CAP);
    expect(capTitle(at)).toBe(at);
    expect(capTitle(`${at}y`)).toBe(`${"x".repeat(TITLE_CAP - 1)}…`);
  });
});

describe(titleText, () => {
  it("joins the text blocks, cleans and caps", () => {
    expect(
      titleText(
        fauxAssistantMessage([
          fauxText('"Plans for'),
          fauxText(' the weekend"\nignored'),
        ])
      )
    ).toBe("Plans for the weekend");
    expect(titleText(fauxAssistantMessage([fauxText("   ")]))).toBeUndefined();
    expect(titleText(fauxAssistantMessage([]))).toBeUndefined();
    expect(
      titleText(fauxAssistantMessage([fauxText("x".repeat(120))]))
    ).toHaveLength(TITLE_CAP);
  });
});

describe(titleMessages, () => {
  it("lists each exchange part under its label, capped", () => {
    const [system, user] = titleMessages({
      firstUser: "first",
      firstAnswer: "answer",
      latestUser: "latest",
      latestAnswer: "reply",
    });
    expect(system?.role).toBe("system");
    expect(user).toMatchObject({
      role: "user",
      content:
        "First message:\nfirst\n\nFirst answer:\nanswer\n\nLatest message:\nlatest\n\nLatest answer:\nreply",
    });
    const [, onlyFirst] = titleMessages({ firstUser: "only" });
    expect(onlyFirst).toMatchObject({
      role: "user",
      content: "First message:\nonly",
    });
  });
});
