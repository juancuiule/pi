"use client";

import { ArrowUp } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";

import { Button } from "@/components/ui/button";
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
  inputRef?: Ref<HTMLTextAreaElement>;
}) => {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card focus-within:border-ring focus-within:ring-ring/50 flex items-end gap-2 rounded-xl border p-1.5 shadow-xs focus-within:ring-3">
        <textarea
          ref={inputRef}
          autoFocus
          aria-label="Message"
          placeholder={placeholder}
          rows={tall ? 3 : 1}
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
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
