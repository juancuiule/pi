import { describe, expect, it } from "vitest";

import { complete } from "./autocomplete";
import {
  matchSkills,
  skillQuery,
  skillSuggestions,
} from "./skill-autocomplete";

const skills = [
  { name: "convert", description: "Convert units" },
  { name: "report", description: "Report on a repo" },
  { name: "notes", description: "Notes on the desktop" },
];

const query = (prompt: string, cursor?: number) =>
  skillQuery(prompt, cursor)?.query;

/** The prompt after picking the first suggestion at `cursor`. */
const pickFirst = (prompt: string, cursor = prompt.length) => {
  const suggestions = skillSuggestions(prompt, cursor, skills);
  if (suggestions === undefined) {
    throw new Error(`no suggestions in ${prompt}`);
  }
  return complete(prompt, suggestions, suggestions.options[0]);
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

describe(skillSuggestions, () => {
  it("completes to the command with a trailing space", () => {
    expect(pickFirst("/rep")).toStrictEqual({
      prompt: "/skill:report ",
      cursor: 14,
    });
  });

  it("replaces a mention in the middle, keeping the rest", () => {
    expect(pickFirst("try /sk then go", 7)).toStrictEqual({
      prompt: "try /skill:convert then go",
      cursor: 19,
    });
  });

  it("offers nothing when no skill matches", () => {
    expect(skillSuggestions("/zzz", 4, skills)).toBeUndefined();
  });
});
