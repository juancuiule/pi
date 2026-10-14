// Pure helpers for the Capacity dialog: which Conversations hold the resource a request is short of, and how to
// describe the shortage.
import type { ConversationSummary } from "effect-pi/api";

import type { CapacityShortage } from "./api";

export interface Holder {
  readonly id: number;
  readonly title: string;
  readonly running: boolean;
  /** Its Pause already waits for the current Run to end. */
  readonly pausing: boolean;
}

/** The holders named by `shortage`, as the list shows them; ones the list does not know yet are left out. */
export const holdersOf = (
  shortage: CapacityShortage,
  conversations: readonly ConversationSummary[]
): Holder[] =>
  shortage.holders.flatMap((id) => {
    const found = conversations.find((c) => c.id === id);
    return found === undefined
      ? []
      : [
          {
            id,
            title: found.title,
            running: found.status === "running",
            pausing: found.pausing,
          },
        ];
  });

const NOUNS: Record<CapacityShortage["resource"], [string, string]> = {
  seat: ["active conversation", "active conversations"],
  shell: ["shell sandbox", "shell sandboxes"],
  desktop: ["desktop sandbox", "desktop sandboxes"],
};

/** "All 3 shell sandboxes are in use." */
export const shortageText = (shortage: CapacityShortage): string => {
  const [one, many] = NOUNS[shortage.resource];
  return shortage.limit === 1
    ? `The only ${one} is in use.`
    : `All ${shortage.limit} ${many} are in use.`;
};
