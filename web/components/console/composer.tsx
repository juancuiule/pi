"use client";

import { ArrowUp, BookOpen, Paperclip } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { ACCEPTED_FILES, canSend } from "@/lib/attachments";
import type { DraftAttachment } from "@/lib/attachments";
import { useCapabilities } from "@/lib/queries";
import {
  completeSkill,
  matchSkills,
  moveSelection,
  skillQuery,
} from "@/lib/skill-autocomplete";
import { shouldSubmit } from "@/lib/transcript";
import { cn } from "@/lib/utils";

import { DraftChip } from "./attachment-chip";

/** Files for the next message: added by the picker, a drop or a paste; each uploads at once. */
export interface ComposerAttachments {
  readonly items: readonly DraftAttachment[];
  readonly onAdd: (files: File[]) => void;
  readonly onRemove: (key: string) => void;
}

const hasFiles = (event: DragEvent) =>
  event.dataTransfer.types.includes("Files");

/** Whether files are dragged over the box, and the handlers that take them when dropped. */
const useFileDrop = (attachments: ComposerAttachments | undefined) => {
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    onDragOver: (event: DragEvent) => {
      if (attachments === undefined || !hasFiles(event)) {
        return;
      }
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      setDragging(false);
      if (attachments === undefined || !hasFiles(event)) {
        return;
      }
      event.preventDefault();
      attachments.onAdd([...event.dataTransfer.files]);
    },
  };
};

const sendable = (
  prompt: string,
  attachments: ComposerAttachments | undefined
) => canSend(prompt, attachments?.items ?? []);

/** The files of the next message, each with its status and a remove button. */
const DraftList = ({
  attachments,
}: {
  attachments: ComposerAttachments | undefined;
}) =>
  attachments === undefined || attachments.items.length === 0 ? null : (
    <ul aria-label="Attached files" className="flex flex-wrap gap-1.5">
      {attachments.items.map((draft) => (
        <DraftChip
          key={draft.key}
          draft={draft}
          onRemove={() => attachments.onRemove(draft.key)}
        />
      ))}
    </ul>
  );

/** A paste of files adds them instead of their names. */
const pasteHandler =
  (attachments: ComposerAttachments | undefined) =>
  (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (attachments !== undefined && files.length > 0) {
      event.preventDefault();
      attachments.onAdd(files);
    }
  };

/** The paperclip: a file picker for the formats the server reads; none for a composer without attachments. */
const AttachButton = ({
  attachments,
}: {
  attachments: ComposerAttachments | undefined;
}) => {
  const picker = useRef<HTMLInputElement>(null);
  if (attachments === undefined) {
    return null;
  }
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(event) => {
          attachments.onAdd([...(event.target.files ?? [])]);
          // The same file can be picked again after removing it.
          event.target.value = "";
        }}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach text, Markdown, HTML, CSV, TSV, PDF or image files"
        onClick={() => picker.current?.click()}
      >
        <Paperclip />
      </Button>
    </>
  );
};

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
  attachments,
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
  attachments?: ComposerAttachments;
}) => {
  const { dragging, ...dropHandlers } = useFileDrop(attachments);
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
              <span
                className="text-muted-foreground line-clamp-2 text-xs leading-normal"
                title={option.description}
              >
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
      <div
        {...dropHandlers}
        className={cn(
          "bg-card focus-within:border-ring focus-within:ring-ring/50 flex flex-col gap-1.5 rounded-xl border p-1.5 shadow-xs focus-within:ring-3",
          dragging && "border-ring ring-ring/50 ring-3"
        )}
      >
        <DraftList attachments={attachments} />
        <div className="flex items-end gap-2">
          <AttachButton attachments={attachments} />
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
            onPaste={pasteHandler(attachments)}
            className={cn(
              "placeholder:text-muted-foreground md:text-prose field-sizing-content max-h-44 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-base outline-none",
              tall ? "min-h-24" : "min-h-9"
            )}
          />
          <Button
            size="icon-sm"
            aria-label={running ? "Queue message" : "Send"}
            disabled={pending || !sendable(prompt, attachments)}
            onClick={onSubmit}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground px-1 text-xs">{hint}</p>
    </div>
  );
};
