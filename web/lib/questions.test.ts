import { describe, expect, it } from "vitest";

import {
  answersPayload,
  isComplete,
  questionsOf,
  setOther,
  submittedAnswers,
  toggleOption,
} from "./questions";
import type { Question } from "./questions";

const questions = questionsOf({
  questions: [
    {
      id: "db",
      question: "Which database?",
      header: "Database",
      options: [
        { label: "SQLite", description: "One file" },
        { label: "Postgres" },
      ],
    },
    {
      id: "features",
      question: "Which features?",
      options: [{ label: "Auth" }, { label: "Billing" }],
      multiple: true,
    },
    { id: "broken" },
  ],
});
// Two questions: the malformed one is skipped.
const [single, multiple] = questions as [Question, Question];

describe(questionsOf, () => {
  it("reads the questions and skips malformed ones", () => {
    expect(questions).toStrictEqual([
      {
        id: "db",
        question: "Which database?",
        header: "Database",
        options: [
          { label: "SQLite", description: "One file" },
          { label: "Postgres", description: undefined },
        ],
        multiple: false,
      },
      {
        id: "features",
        question: "Which features?",
        header: undefined,
        options: [
          { label: "Auth", description: undefined },
          { label: "Billing", description: undefined },
        ],
        multiple: true,
      },
    ]);
    expect(questionsOf()).toStrictEqual([]);
  });
});

describe("the draft", () => {
  it("keeps one pick for a single-choice question, the person's text included", () => {
    let draft = toggleOption({}, single, "SQLite");
    draft = toggleOption(draft, single, "Postgres");
    expect(draft.db).toStrictEqual({
      selected: ["Postgres"],
      other: undefined,
    });
    draft = setOther(draft, single, "DuckDB");
    expect(draft.db).toStrictEqual({ selected: [], other: "DuckDB" });
    draft = toggleOption(draft, single, "SQLite");
    expect(draft.db).toStrictEqual({ selected: ["SQLite"], other: undefined });
  });

  it("toggles options and the person's text independently in a multiple-choice question", () => {
    let draft = toggleOption({}, multiple, "Auth");
    draft = toggleOption(draft, multiple, "Billing");
    draft = setOther(draft, multiple, "Exports");
    draft = toggleOption(draft, multiple, "Auth");
    expect(draft.features).toStrictEqual({
      selected: ["Billing"],
      other: "Exports",
    });
  });

  it("is complete once every question has an option or some text", () => {
    let draft = toggleOption({}, single, "SQLite");
    expect(isComplete(questions, draft)).toBeFalsy();
    draft = setOther(draft, multiple, "  ");
    expect(isComplete(questions, draft)).toBeFalsy();
    draft = setOther(draft, multiple, " Exports ");
    expect(isComplete(questions, draft)).toBeTruthy();
    expect(answersPayload(questions, draft)).toStrictEqual([
      { id: "db", selected: ["SQLite"] },
      { id: "features", selected: [], other: "Exports" },
    ]);
  });
});

describe(submittedAnswers, () => {
  it("reads the answers from an answered call's details", () => {
    const answers = submittedAnswers({
      approval: "answered",
      answers: [{ id: "db", selected: ["SQLite"], other: "WAL" }, { nope: 1 }],
    });
    expect([...answers.values()]).toStrictEqual([
      { id: "db", selected: ["SQLite"], other: "WAL" },
    ]);
    expect(submittedAnswers({ approval: "skipped" }).size).toBe(0);
  });
});
