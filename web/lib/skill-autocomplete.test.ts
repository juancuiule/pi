import { describe, expect, it } from "vitest";

import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "./skill-autocomplete";

const skills = [
  { name: "unit-conversion", description: "Convert units" },
  { name: "repo-report", description: "Report on a repo" },
  { name: "desktop-notes", description: "Notes on the desktop" },
];

describe(skillQuery, () => {
  it("reads the query while the prompt is a bare slash command", () => {
    expect(skillQuery("/")).toBe("");
    expect(skillQuery("/rep")).toBe("rep");
    expect(skillQuery("/skill:")).toBe("");
    expect(skillQuery("/skill:rep")).toBe("rep");
  });

  it("closes once there is whitespace or no leading slash", () => {
    expect(skillQuery("/skill:repo-report ")).toBeUndefined();
    expect(skillQuery("hello /rep")).toBeUndefined();
    expect(skillQuery("")).toBeUndefined();
  });
});

describe(matchSkills, () => {
  it("prefix-matches names, sorted", () => {
    expect(matchSkills(skills, "").map((s) => s.name)).toStrictEqual([
      "desktop-notes",
      "repo-report",
      "unit-conversion",
    ]);
    expect(matchSkills(skills, "re").map((s) => s.name)).toStrictEqual([
      "repo-report",
    ]);
    expect(matchSkills(skills, "zzz")).toStrictEqual([]);
  });

  it("lists every skill while the query is the start of 'skill:'", () => {
    expect(matchSkills(skills, "sk")).toHaveLength(3);
  });
});

describe(completeSkill, () => {
  it("completes to the command with a trailing space", () => {
    expect(completeSkill("repo-report")).toBe("/skill:repo-report ");
  });
});

describe(moveSelection, () => {
  it("wraps around", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
