import { describe, expect, it } from "vitest";

import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "./skill-autocomplete";

const skills = [
  { name: "convert", description: "Convert units" },
  { name: "report", description: "Report on a repo" },
  { name: "notes", description: "Notes on the desktop" },
];

const query = (prompt: string, cursor?: number) =>
  skillQuery(prompt, cursor)?.query;

const tokenAt = (prompt: string, cursor?: number) => {
  const token = skillQuery(prompt, cursor);
  if (token === undefined) {
    throw new Error(`no token in ${prompt}`);
  }
  return token;
};

describe(skillQuery, () => {
  it("reads the query while the prompt starts with a slash command", () => {
    expect(query("/")).toBe("");
    expect(query("/rep")).toBe("rep");
    expect(query("/skill:")).toBe("");
    expect(query("/skill:rep")).toBe("rep");
  });

  it("reads a mention after whitespace once /s is typed", () => {
    expect(query("convert this /s")).toBe("s");
    expect(query("convert this\n/skill:un")).toBe("un");
    expect(skillQuery("a /skill:un b", 11)).toStrictEqual({
      query: "un",
      start: 2,
      end: 11,
    });
  });

  it("finds the word at the cursor, up to its end", () => {
    expect(skillQuery("x /skill:repo y", 9)).toStrictEqual({
      query: "",
      start: 2,
      end: 13,
    });
  });

  it("stays closed for paths, finished words and ordinary text", () => {
    expect(query("/skill:report ")).toBeUndefined();
    expect(query("hello /")).toBeUndefined();
    expect(query("hello /rep")).toBeUndefined();
    expect(query("cat /usr/bin")).toBeUndefined();
    expect(query("and/s")).toBeUndefined();
  });

  it("opens after a word that contains a slash", () => {
    expect(query("and/or /s")).toBe("s");
  });

  it("is closed for an empty prompt", () => {
    expect(query("")).toBeUndefined();
  });
});

describe(matchSkills, () => {
  it("prefix-matches names, sorted", () => {
    expect(matchSkills(skills, "").map((s) => s.name)).toStrictEqual([
      "convert",
      "notes",
      "report",
    ]);
    expect(matchSkills(skills, "re").map((s) => s.name)).toStrictEqual([
      "report",
    ]);
    expect(matchSkills(skills, "zzz")).toStrictEqual([]);
  });

  it("lists every skill while the query is the start of 'skill:'", () => {
    expect(matchSkills(skills, "sk")).toHaveLength(3);
  });
});

describe(completeSkill, () => {
  it("completes to the command with a trailing space", () => {
    const prompt = "/rep";
    expect(completeSkill(prompt, tokenAt(prompt), "report")).toStrictEqual({
      prompt: "/skill:report ",
      cursor: 14,
    });
  });

  it("replaces a mention in the middle, keeping the rest", () => {
    const prompt = "try /sk then go";
    expect(completeSkill(prompt, tokenAt(prompt, 7), "convert")).toStrictEqual({
      prompt: "try /skill:convert then go",
      cursor: 19,
    });
  });
});

describe(moveSelection, () => {
  it("wraps around", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
