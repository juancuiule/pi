// Text to put in whichever composer is on screen, such as `/skill:<name> ` chosen on the skills page. A composer
// takes each offered draft once, including one offered before it mounted, and registers its textarea to focus.
import { useEffect } from "react";
import type { RefObject } from "react";
import { create } from "zustand";

interface Draft {
  readonly draft: string | undefined;
  /** The mounted composer's textarea. */
  readonly target: RefObject<HTMLTextAreaElement | null> | undefined;
  offer(text: string): void;
  take(): string | undefined;
}

export const useDraft = create<Draft>()((set, get) => ({
  draft: undefined,
  target: undefined,
  offer: (text) => set({ draft: text }),
  take: () => {
    const { draft } = get();
    set({ draft: undefined });
    return draft;
  },
}));

/**
 * Hand every draft offered to `onDraft`, once: one waiting from before the caller mounted, then each later offer.
 * `target` is registered as the composer to focus. `onDraft` should be stable (a setState).
 */
export const useTakeDraft = (
  onDraft: (text: string) => void,
  target: RefObject<HTMLTextAreaElement | null>
): void => {
  useEffect(() => {
    useDraft.setState({ target });
    const pending = useDraft.getState().take();
    if (pending !== undefined) {
      onDraft(pending);
      target.current?.focus();
    }
    const unsubscribe = useDraft.subscribe((state) => {
      if (state.draft === undefined) {
        return;
      }
      const text = state.take();
      if (text !== undefined) {
        onDraft(text);
      }
    });
    return () => {
      unsubscribe();
      if (useDraft.getState().target === target) {
        useDraft.setState({ target: undefined });
      }
    };
  }, [onDraft, target]);
};
