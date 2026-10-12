// Text to put in whichever composer is on screen, such as `/skill:<name> ` chosen in the capabilities sheet. The
// mounted composer takes it once.
import { useEffect } from "react";
import { create } from "zustand";

interface Draft {
  readonly draft: string | undefined;
  offer(text: string): void;
  take(): string | undefined;
}

export const useDraft = create<Draft>()((set, get) => ({
  draft: undefined,
  offer: (text) => set({ draft: text }),
  take: () => {
    const { draft } = get();
    set({ draft: undefined });
    return draft;
  },
}));

/** Hand every draft offered while the caller is mounted to `onDraft`, once. `onDraft` should be stable (a setState). */
export const useTakeDraft = (onDraft: (text: string) => void): void => {
  useEffect(
    () =>
      useDraft.subscribe((state) => {
        if (state.draft === undefined) {
          return;
        }
        const text = state.take();
        if (text !== undefined) {
          onDraft(text);
        }
      }),
    [onDraft]
  );
};
