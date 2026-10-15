"use client";

import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { Check, LoaderCircle } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { useAnswers } from "@/lib/approval-context";
import {
  answerIn,
  answersPayload,
  isComplete,
  setOther,
  submittedAnswers,
  toggleOption,
} from "@/lib/questions";
import type { Draft, Question } from "@/lib/questions";
import { cn } from "@/lib/utils";

const OTHER = "\u0000other";

const CHOICE =
  "focus-visible:border-ring focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-accent data-checked:ring-primary flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors duration-150 outline-none focus-visible:ring-3 data-checked:ring-1";

const Mark = ({ multiple }: { multiple: boolean }) => (
  <span
    aria-hidden
    className={cn(
      "border-input group-data-checked:border-primary group-data-checked:bg-primary text-primary-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center border",
      multiple ? "rounded-sm" : "rounded-full"
    )}
  >
    {multiple ? (
      <Check className="hidden size-3 group-data-checked:block" />
    ) : (
      <span className="bg-primary-foreground hidden size-1.5 rounded-full group-data-checked:block" />
    )}
  </span>
);

const ChoiceText = ({
  label,
  description,
}: {
  label: ReactNode;
  description?: string | undefined;
}) => (
  <span className="flex min-w-0 flex-col gap-0.5">
    <span className="text-sm font-medium">{label}</span>
    {description === undefined ? null : (
      <span className="text-muted-foreground text-xs">{description}</span>
    )}
  </span>
);

const QuestionField = ({
  question,
  draft,
  onChange,
  disabled,
}: {
  question: Question;
  draft: Draft;
  onChange: (next: Draft) => void;
  disabled: boolean;
}) => {
  const legendId = useId();
  const otherInput = useRef<HTMLInputElement>(null);
  const answer = answerIn(draft, question.id);
  const otherPicked = answer.other !== undefined;
  const pickOther = (picked: boolean) => {
    onChange(
      setOther(draft, question, picked ? (answer.other ?? "") : undefined)
    );
    if (picked) {
      // After the input mounts.
      requestAnimationFrame(() => otherInput.current?.focus());
    }
  };
  const otherText = otherPicked ? (
    <input
      ref={otherInput}
      value={answer.other}
      disabled={disabled}
      aria-label={`Your answer to: ${question.question}`}
      placeholder="Type your answer"
      onChange={(event) =>
        onChange(setOther(draft, question, event.target.value))
      }
      className="border-input focus-visible:border-ring focus-visible:ring-ring/50 bg-background mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3"
    />
  ) : null;

  const options = question.multiple ? (
    <div className="flex flex-col gap-2">
      {question.options.map((option) => (
        <Checkbox.Root
          key={option.label}
          checked={answer.selected.includes(option.label)}
          disabled={disabled}
          onCheckedChange={() =>
            onChange(toggleOption(draft, question, option.label))
          }
          className={cn("group", CHOICE)}
        >
          <Mark multiple />
          <ChoiceText label={option.label} description={option.description} />
        </Checkbox.Root>
      ))}
      <div className="flex flex-col">
        <Checkbox.Root
          checked={otherPicked}
          disabled={disabled}
          onCheckedChange={(checked) => pickOther(checked)}
          className={cn("group", CHOICE)}
        >
          <Mark multiple />
          <ChoiceText label="Other" />
        </Checkbox.Root>
        {otherText}
      </div>
    </div>
  ) : (
    <RadioGroup
      aria-labelledby={legendId}
      value={otherPicked ? OTHER : (answer.selected[0] ?? null)}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === OTHER) {
          pickOther(true);
        } else if (typeof value === "string") {
          onChange(toggleOption(draft, question, value));
        }
      }}
    >
      {question.options.map((option) => (
        <Radio.Root
          key={option.label}
          value={option.label}
          className={cn("group", CHOICE)}
        >
          <Mark multiple={false} />
          <ChoiceText label={option.label} description={option.description} />
        </Radio.Root>
      ))}
      <div className="flex flex-col">
        <Radio.Root value={OTHER} className={cn("group", CHOICE)}>
          <Mark multiple={false} />
          <ChoiceText label="Other" />
        </Radio.Root>
        {otherText}
      </div>
    </RadioGroup>
  );

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend id={legendId} className="mb-2 flex flex-col gap-0.5">
        {question.header === undefined ? null : (
          <span className="text-muted-foreground text-xs font-medium">
            {question.header}
          </span>
        )}
        <span className="text-sm font-medium text-pretty">
          {question.question}
        </span>
        <span className="text-muted-foreground text-xs">
          {question.multiple ? "Pick any that apply" : "Pick one"}
        </span>
      </legend>
      {options}
    </fieldset>
  );
};

/** The form for an `ask_user` call that waits for answers. */
export const QuestionForm = ({
  questions,
  answerKey,
}: {
  questions: readonly Question[];
  answerKey: string;
}) => {
  const mutation = useAnswers();
  const [draft, setDraft] = useState<Draft>({});
  const busy = mutation?.isPending ?? false;
  const submit = (skip: boolean) => {
    mutation?.mutate(
      skip
        ? { key: answerKey }
        : { key: answerKey, answers: answersPayload(questions, draft) },
      { onError: (error) => toast.error(error.message) }
    );
  };
  const sending = busy && mutation?.variables?.key === answerKey;
  const skipping = sending && mutation?.variables?.answers === undefined;
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (isComplete(questions, draft)) {
          submit(false);
        }
      }}
    >
      {questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          draft={draft}
          onChange={setDraft}
          disabled={busy}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !isComplete(questions, draft)}
        >
          {sending && !skipping ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          Send answers
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => submit(true)}
        >
          {skipping ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          Skip
        </Button>
      </div>
    </form>
  );
};

/** An `ask_user` call's questions with what the person answered, once it is no longer waiting. */
export const AnsweredQuestions = ({
  questions,
  details,
}: {
  questions: readonly Question[];
  details: unknown;
}) => {
  const answers = submittedAnswers(details);
  return (
    <dl className="flex flex-col gap-3">
      {questions.map((question) => {
        const answer = answers.get(question.id);
        const parts = [
          ...(answer?.selected ?? []),
          ...(answer?.other === undefined ? [] : [answer.other]),
        ];
        return (
          <div key={question.id} className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground text-xs">
              {question.question}
            </dt>
            <dd className="text-sm">
              {parts.length === 0 ? (
                <span className="text-muted-foreground">No answer</span>
              ) : (
                parts.join(", ")
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
};
