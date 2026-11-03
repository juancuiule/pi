"use client";

// Dictation wired into a composer's textarea: final text goes where the caret was when dictation started (the
// anchor), each final after the previous one, and edits the person makes meanwhile shift the anchor. The caret follows
// the dictated text unless the person moved it elsewhere. ⌘⇧Space / Ctrl+Shift+Space toggles from anywhere on the page.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import { insertDictated, isDictationShortcut, shiftAnchor } from "./dictation";
import { useDictation } from "./use-dictation";

export const useComposerDictation = ({
  prompt,
  onPrompt,
  textarea,
  onCaret,
}: {
  readonly prompt: string;
  readonly onPrompt: (value: string) => void;
  readonly textarea: RefObject<HTMLTextAreaElement | null>;
  /** Moves the caret to `position` once the prompt has re-rendered. */
  readonly onCaret: (position: number) => void;
}) => {
  // Finals arrive between renders, so they read the latest prompt and callbacks through refs.
  const latest = useRef({ prompt, onPrompt, onCaret });
  useLayoutEffect(() => {
    latest.current = { prompt, onPrompt, onCaret };
  });
  const anchor = useRef<number | null>(null);

  const dictation = useDictation({
    onFinal: (text) => {
      const element = textarea.current;
      const { current } = latest;
      const from = anchor.current ?? current.prompt.length;
      const follow =
        element === null ||
        document.activeElement !== element ||
        element.selectionStart === from;
      const next = insertDictated(current.prompt, from, text);
      anchor.current = next.anchor;
      current.prompt = next.value;
      current.onPrompt(next.value);
      if (follow) {
        current.onCaret(next.anchor);
      }
    },
  });

  const toggleDictation = () => {
    if (dictation.status === "idle") {
      anchor.current =
        textarea.current?.selectionStart ?? latest.current.prompt.length;
    }
    dictation.toggle();
  };
  const toggleRef = useRef(toggleDictation);
  useLayoutEffect(() => {
    toggleRef.current = toggleDictation;
  });

  const { enabled } = dictation;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onShortcut = (event: KeyboardEvent) => {
      if (isDictationShortcut(event)) {
        event.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [enabled]);

  /** The person typed: an edit before the anchor moves it. */
  const editedDuringDictation = (next: string) => {
    if (dictation.status !== "idle" && anchor.current !== null) {
      anchor.current = shiftAnchor(latest.current.prompt, next, anchor.current);
    }
  };

  return { dictation, toggleDictation, editedDuringDictation };
};
