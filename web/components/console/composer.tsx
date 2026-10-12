"use client";

import { ArrowUp, BookOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { useCapabilities } from "@/lib/queries";
import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "@/lib/skill-autocomplete";
import { shouldSubmit } from "@/lib/transcript";
import { cn } from "@/lib/utils";

export const Composer = ({
  prompt,
  onPrompt,
  onSubmit,
  pending = false,
  running = false,
  placeholder,
  hint,
  tall = false,
  inputRef,
}: {
  prompt: string;
  onPrompt: (value: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  /** While a run is live, sends queue instead of interrupting. */
  running?: boolean;
  placeholder: string;
  /** The small muted line under the box. */
  hint: ReactNode;
  /** Roomier box for the start-of-conversation form. */
  tall?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) => {
  const { data } = useCapabilities();
  const [selected, setSelected] = useState(0);
  // The prompt the list was dismissed for (Esc); it reopens once the prompt changes.
  const [dismissed, setDismissed] = useState<string>();
  // The caret, so a `/skill:` mention can be completed anywhere in the prompt. Unknown until the user types or
  // moves it, or stale after the prompt is set from outside: then the end of the prompt.
  const [cursor, setCursor] = useState<number>();
  const ownTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? ownTextarea;
  // Where to put the caret once a completion has re-rendered the textarea.
  const caretAfterRender = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = caretAfterRender.current;
    if (at !== null) {
      textarea.current?.setSelectionRange(at, at);
      caretAfterRender.current = null;
    }
  });
  const token = skillQuery(
    prompt,
    cursor === undefined || cursor > prompt.length ? prompt.length : cursor
  );
  const options =
    token === undefined || dismissed === prompt
      ? []
      : matchSkills(data?.skills ?? [], token.query);
  const active = options[Math.min(selected, options.length - 1)];

  const complete = (name: string) => {
    if (token === undefined) {
      return;
    }
    const next = completeSkill(prompt, token, name);
    onPrompt(next.prompt);
    setCursor(next.cursor);
    caretAfterRender.current = next.cursor;
    setSelected(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (active !== undefined) {
      const index = options.indexOf(active);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          moveSelection(
            index,
            event.key === "ArrowDown" ? 1 : -1,
            options.length
          )
        );
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        complete(active.name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(prompt);
        return;
      }
    }
    if (
      shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative flex flex-col gap-2">
      {active === undefined ? null : (
        <div className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-10 mb-2 flex max-h-64 flex-col overflow-y-auto rounded-lg border p-1 shadow-md">
          {options.map((option) => (
            <button
              key={option.name}
              type="button"
              // Arrow keys in the textarea move through the list; it is not a tab stop of its own.
              tabIndex={-1}
              onMouseDown={(event) => {
                // Keeps focus in the textarea.
                event.preventDefault();
                complete(option.name);
              }}
              onMouseEnter={() => setSelected(options.indexOf(option))}
              className={cn(
                "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
                option === active && "bg-accent text-accent-foreground"
              )}
            >
              <span className="flex items-center gap-1.5 font-mono text-sm">
                <BookOpen
                  aria-hidden
                  className="text-muted-foreground size-3.5"
                />
                /skill:{option.name}
              </span>
              <span className="text-muted-foreground line-clamp-2 text-xs">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {active === undefined
          ? ""
          : `/skill:${active.name}, ${options.indexOf(active) + 1} of ${options.length}. Enter or Tab to complete, Escape to close.`}
      </span>
      <div className="bg-card focus-within:border-ring focus-within:ring-ring/50 flex items-end gap-2 rounded-xl border p-1.5 shadow-xs focus-within:ring-3">
        <textarea
          ref={textarea}
          autoFocus
          aria-label="Message"
          placeholder={placeholder}
          rows={tall ? 3 : 1}
          value={prompt}
          onChange={(event) => {
            onPrompt(event.target.value);
            setCursor(event.target.selectionStart);
            setSelected(0);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className={cn(
            "placeholder:text-muted-foreground md:text-prose field-sizing-content max-h-44 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-base outline-none",
            tall ? "min-h-24" : "min-h-9"
          )}
        />
        <Button
          size="icon-sm"
          aria-label={running ? "Queue message" : "Send"}
          disabled={pending || prompt.trim() === ""}
          onClick={onSubmit}
        >
          <ArrowUp />
        </Button>
      </div>
      <p className="text-muted-foreground px-1 text-xs">{hint}</p>
    </div>
  );
};
