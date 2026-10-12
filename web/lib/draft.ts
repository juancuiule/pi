// Text to put in whichever composer is on screen, such as `/skill:<name> ` chosen in the capabilities sheet. The
// mounted composer takes it once, and registers its textarea so the sheet can focus it when it closes.
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
 * Where the sheet sends focus when it closes (its `finalFocus`): the composer after a skill was picked, so typing
 * continues the request; otherwise `true`, the sheet's default of returning to its trigger.
 */
export const focusAfterSheet = (
  picked: boolean,
  target: HTMLElement | null | undefined
): HTMLElement | true => (picked && target ? target : true);

/**
 * Hand every draft offered while the caller is mounted to `onDraft`, once, and register `target` as the composer to
 * focus. `onDraft` should be stable (a setState).
 */
export const useTakeDraft = (
  onDraft: (text: string) => void,
  target: RefObject<HTMLTextAreaElement | null>
): void => {
  useEffect(() => {
    useDraft.setState({ target });
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
