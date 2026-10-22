// The /friction page's views and triage actions, as tables so the page renders from them instead of branching
// on status (src/friction/friction.ts has the log itself).
import type { FrictionEntryInfo } from "effect-pi/api";

export type FrictionStatus = FrictionEntryInfo["status"];

export type FrictionView = FrictionStatus | "all";

interface ViewSpec {
  readonly label: string;
  readonly statuses: readonly FrictionStatus[];
  readonly empty: { readonly title: string; readonly detail: string };
}

/** The page's views, in the order its buttons show them. */
export const FRICTION_VIEW_IDS = [
  "open",
  "resolved",
  "dismissed",
  "all",
] as const satisfies readonly FrictionView[];

export const FRICTION_VIEWS: Record<FrictionView, ViewSpec> = {
  open: {
    label: "Open",
    statuses: ["open"],
    empty: {
      title: "No open friction",
      detail: "Papercuts agents file while working appear here.",
    },
  },
  resolved: {
    label: "Resolved",
    statuses: ["resolved"],
    empty: {
      title: "Nothing resolved yet",
      detail: "Entries you mark resolved appear here.",
    },
  },
  dismissed: {
    label: "Dismissed",
    statuses: ["dismissed"],
    empty: {
      title: "Nothing dismissed",
      detail: "Entries you dismiss appear here.",
    },
  },
  all: {
    label: "All",
    statuses: ["open", "resolved", "dismissed"],
    empty: {
      title: "No friction yet",
      detail: "Papercuts agents file while working appear here.",
    },
  },
};

interface TriageAction {
  readonly label: string;
  readonly status: FrictionStatus;
}

/** What the person can do with an entry in each status. */
export const FRICTION_ACTIONS: Record<FrictionStatus, readonly TriageAction[]> =
  {
    open: [
      { label: "Resolve", status: "resolved" },
      { label: "Dismiss", status: "dismissed" },
    ],
    dismissed: [{ label: "Reopen", status: "open" }],
    resolved: [{ label: "Reopen", status: "open" }],
  };

const inView = (entry: FrictionEntryInfo, view: FrictionView): boolean =>
  FRICTION_VIEWS[view].statuses.includes(entry.status);

/** The entries one view shows, newest first; the API lists them in filing order. */
export const frictionView = (
  entries: readonly FrictionEntryInfo[],
  view: FrictionView
): readonly FrictionEntryInfo[] =>
  entries.filter((entry) => inView(entry, view)).toReversed();

/** How many entries each view shows. */
export const frictionCounts = (
  entries: readonly FrictionEntryInfo[]
): Record<FrictionView, number> => {
  const count = (view: FrictionView) =>
    entries.filter((entry) => inView(entry, view)).length;
  return {
    open: count("open"),
    resolved: count("resolved"),
    dismissed: count("dismissed"),
    all: count("all"),
  };
};
