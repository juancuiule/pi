"use client";

// The console's ⌘K palette: full-text over Conversations through GET /api/search. Each result is one selectable
// row — its title, an Archived badge, and a line per match; Enter or a click opens it at `/?c=<id>`.
import type { SearchResult, SnippetSegment } from "effect-pi/api";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSearch } from "@/lib/queries";
import { isSearchShortcut, useDebouncedValue } from "@/lib/search";
import { moveSelection } from "@/lib/skill-autocomplete";
import { cn } from "@/lib/utils";

const LISTBOX_ID = "search-palette-results";

const optionId = (index: number) => `search-palette-option-${index}`;

const Snippet = ({ segments }: { segments: readonly SnippetSegment[] }) =>
  segments.map((segment, index) =>
    segment.match ? (
      // oxlint-disable-next-line react/no-array-index-key -- snippet segments have no identity beyond their order
      <mark
        key={index}
        className="bg-warning/30 rounded-sm px-0.5 text-inherit"
      >
        {segment.text}
      </mark>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- snippet segments have no identity beyond their order
      <span key={index}>{segment.text}</span>
    )
  );

export const SearchPalette = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // While closed the debounced value settles on "", so a reopen never re-fires the old query.
  const debounced = useDebouncedValue(open ? query : "", 150);
  const { data, isError } = useSearch(debounced, open);
  const results = data ?? [];
  const active =
    results.length === 0 ? -1 : Math.min(selected, results.length - 1);

  // ⌘K / Ctrl+K toggles the palette, even while another field has focus.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  // Every open starts fresh.
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }

  const choose = (result: SearchResult) => {
    router.push(`/?c=${result.id}`);
    onOpenChange(false);
    setQuery("");
    setSelected(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) {
        setSelected(
          moveSelection(
            active,
            event.key === "ArrowDown" ? 1 : -1,
            results.length
          )
        );
      }
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(results[active]);
    }
  };

  let list: ReactNode;
  if (isError) {
    list = (
      <p className="text-muted-foreground px-2 py-6 text-center text-sm">
        Search failed — try again
      </p>
    );
  } else if (data === undefined) {
    list = (
      <p className="text-muted-foreground px-2 py-6 text-center text-sm">
        Searching…
      </p>
    );
  } else if (results.length === 0) {
    list = (
      <p className="text-muted-foreground px-2 py-6 text-center text-sm">
        No conversations found
      </p>
    );
  } else {
    list = results.map((result, index) => (
      // Focus stays in the input; the row is picked with the arrows and Enter or a click.
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- an option in the combobox's listbox, not a standalone control
      <div
        key={result.id}
        id={optionId(index)}
        role="option" // oxlint-disable-line jsx-a11y/prefer-tag-over-role -- the listbox's rows, not select options
        aria-selected={index === active}
        tabIndex={-1}
        onClick={() => choose(result)}
        onMouseEnter={() => setSelected(index)}
        className={cn(
          "flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5",
          index === active && "bg-accent text-accent-foreground"
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">
            {result.title}
          </span>
          {result.archived ? (
            <Badge variant="outline" className="shrink-0">
              Archived
            </Badge>
          ) : null}
        </span>
        {result.matches.map((match, matchIndex) => (
          // oxlint-disable-next-line react/no-array-index-key -- a result's matches have no id
          <span
            key={matchIndex}
            className="text-muted-foreground line-clamp-2 text-xs"
          >
            {match.role === "title" ? (
              "Title match"
            ) : (
              <Snippet segments={match.snippet} />
            )}
          </span>
        ))}
      </div>
    ));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={input}>
        <DialogTitle className="sr-only">Search conversations</DialogTitle>
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search
            aria-hidden
            className="text-muted-foreground size-4 shrink-0"
          />
          <input
            ref={input}
            role="combobox"
            aria-label="Search conversations"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
            placeholder="Search conversations…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            className="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="bg-muted text-tiny text-muted-foreground rounded border px-1 py-0.5 font-sans">
            esc
          </kbd>
        </div>
        <div
          id={LISTBOX_ID}
          role="listbox" // oxlint-disable-line jsx-a11y/prefer-tag-over-role -- the combobox's popup, not a select
          aria-label="Conversations"
          className="max-h-[50vh] overflow-y-auto p-1.5"
        >
          {list}
        </div>
      </DialogContent>
    </Dialog>
  );
};
