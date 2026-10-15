// Pure parts of the `ask_user` form (src/tools/questions.ts): reading the call's questions, the person's draft
// answers, and what the server gets. A single-choice question takes one option or the person's own text; a
// multiple-choice one takes any options plus, optionally, their own text.
import type { QuestionAnswer } from "effect-pi/api";

export interface QuestionOption {
  readonly label: string;
  readonly description: string | undefined;
}

export interface Question {
  readonly id: string;
  readonly question: string;
  readonly header: string | undefined;
  readonly options: readonly QuestionOption[];
  readonly multiple: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The call's questions, skipping malformed ones; the server validated the arguments, the stream may be partial. */
export const questionsOf = (args?: unknown): readonly Question[] => {
  const list = (args as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((item: unknown): Question[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = text(record.id);
    const question = text(record.question);
    if (id === undefined || question === undefined) {
      return [];
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option: unknown): QuestionOption[] => {
          const each = (option ?? {}) as Record<string, unknown>;
          const label = text(each.label);
          return label === undefined
            ? []
            : [{ label, description: text(each.description) }];
        })
      : [];
    return [
      {
        id,
        question,
        header: text(record.header),
        options,
        multiple: record.multiple === true,
      },
    ];
  });
};

/** One question's draft: the options picked, and the person's own text (`undefined` while "Other" is not picked). */
export interface DraftAnswer {
  readonly selected: readonly string[];
  readonly other: string | undefined;
}

export type Draft = Readonly<Record<string, DraftAnswer>>;

const EMPTY: DraftAnswer = { selected: [], other: undefined };

export const answerIn = (draft: Draft, id: string): DraftAnswer =>
  draft[id] ?? EMPTY;

/** Pick or unpick an option; in a single-choice question it replaces the pick, the person's text included. */
export const toggleOption = (
  draft: Draft,
  question: Question,
  label: string
): Draft => {
  const current = answerIn(draft, question.id);
  if (!question.multiple) {
    return { ...draft, [question.id]: { selected: [label], other: undefined } };
  }
  const selected = current.selected.includes(label)
    ? current.selected.filter((each) => each !== label)
    : [...current.selected, label];
  return { ...draft, [question.id]: { ...current, selected } };
};

/** Pick "Other" (with `""`), type in it, or unpick it (`undefined`); in a single-choice question it replaces the pick. */
export const setOther = (
  draft: Draft,
  question: Question,
  other: string | undefined
): Draft => {
  const current = answerIn(draft, question.id);
  return {
    ...draft,
    [question.id]: {
      selected:
        question.multiple || other === undefined ? current.selected : [],
      other,
    },
  };
};

export const isAnswered = (answer: DraftAnswer): boolean =>
  answer.selected.length > 0 || (answer.other ?? "").trim() !== "";

/** True once every question has an option or some text of the person's own. */
export const isComplete = (
  questions: readonly Question[],
  draft: Draft
): boolean =>
  questions.length > 0 &&
  questions.every((question) => isAnswered(answerIn(draft, question.id)));

/** What `POST /conversations/:id/answers` takes. */
export const answersPayload = (
  questions: readonly Question[],
  draft: Draft
): QuestionAnswer[] =>
  questions.flatMap((question) => {
    const answer = answerIn(draft, question.id);
    if (!isAnswered(answer)) {
      return [];
    }
    const other = (answer.other ?? "").trim();
    return [
      {
        id: question.id,
        selected: [...answer.selected],
        ...(other === "" ? {} : { other }),
      },
    ];
  });

/** The answers an answered call's details carry, by question id. */
export const submittedAnswers = (
  details: unknown
): ReadonlyMap<string, QuestionAnswer> => {
  const answers = (details as { answers?: unknown } | null | undefined)
    ?.answers;
  if (!Array.isArray(answers)) {
    return new Map();
  }
  return new Map(
    answers.flatMap((answer: unknown): [string, QuestionAnswer][] => {
      const each = (answer ?? {}) as Record<string, unknown>;
      const id = text(each.id);
      if (id === undefined) {
        return [];
      }
      const selected = Array.isArray(each.selected)
        ? each.selected.filter(
            (label): label is string => typeof label === "string"
          )
        : [];
      const other = text(each.other);
      return [
        [id, { id, selected, ...(other === undefined ? {} : { other }) }],
      ];
    })
  );
};
