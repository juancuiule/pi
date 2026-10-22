// The friction log: lasting pain the agent hits while working, in this platform or in the person's project. One log
// is shared by every conversation, and the person triages it on the console's /friction page. It is a session-scoped
// document, so the tools write it in the run's own commit.
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

export const MAX_ENTRIES = 200;
export const MAX_NOTES = 50;

export type FrictionScope = "platform" | "project";
export type FrictionStatus = "open" | "dismissed" | "resolved";

// Types, not interfaces: they are stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type FrictionNote = {
  readonly text: string;
  readonly conversationId: number;
  readonly createdAt: number;
};

// oxlint-disable-next-line typescript/consistent-type-definitions
export type FrictionEntry = {
  readonly id: string;
  readonly scope: FrictionScope;
  readonly title: string;
  readonly whatHappened: string;
  readonly expectedOrWhyItHurt: string;
  /** The conversation that filed it. */
  readonly conversationId: number;
  readonly createdAt: number;
  readonly status: FrictionStatus;
  readonly notes: FrictionNote[];
};

// oxlint-disable-next-line typescript/consistent-type-definitions
export type FrictionState = {
  entries: FrictionEntry[];
  /** The next entry's id is `f<nextNumber>`; ids are never reused. */
  nextNumber: number;
};

export const FrictionDoc = defineDoc<FrictionState>({
  kind: "app.friction",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [], nextNumber: 1 }),
});

export interface FrictionInput {
  readonly scope: FrictionScope;
  readonly title: string;
  readonly whatHappened: string;
  readonly expectedOrWhyItHurt: string;
}

/**
 * Add an entry. At the cap the oldest triaged entry makes room; open ones are never dropped, so a log of
 * `MAX_ENTRIES` open entries is `"full"`.
 */
export const addEntry = (
  state: FrictionState,
  input: FrictionInput,
  conversationId: number,
  now: number
): FrictionEntry | "full" => {
  if (state.entries.length >= MAX_ENTRIES) {
    const oldest = state.entries.findIndex((entry) => entry.status !== "open");
    if (oldest === -1) {
      return "full";
    }
    state.entries.splice(oldest, 1);
  }
  const entry: FrictionEntry = {
    id: `f${state.nextNumber}`,
    scope: input.scope,
    title: input.title.trim(),
    whatHappened: input.whatHappened.trim(),
    expectedOrWhyItHurt: input.expectedOrWhyItHurt.trim(),
    conversationId,
    createdAt: now,
    status: "open",
    notes: [],
  };
  state.nextNumber += 1;
  state.entries.push(entry);
  return entry;
};

/** An entry's status after a new note: the pain came back, so a resolved entry reopens; a dismissal stands. */
const AFTER_NOTE: Record<FrictionStatus, FrictionStatus> = {
  open: "open",
  resolved: "open",
  dismissed: "dismissed",
};

/** Append a note to an entry, or `undefined` when there is no such entry. */
export const noteEntry = (
  state: FrictionState,
  id: string,
  text: string,
  conversationId: number,
  now: number
): FrictionEntry | undefined => {
  const index = state.entries.findIndex((entry) => entry.id === id);
  const entry = state.entries[index];
  if (entry === undefined) {
    return undefined;
  }
  const noted: FrictionEntry = {
    ...entry,
    status: AFTER_NOTE[entry.status],
    notes: [
      ...entry.notes,
      { text: text.trim(), conversationId, createdAt: now },
    ].slice(-MAX_NOTES),
  };
  state.entries[index] = noted;
  return noted;
};

/** The person's triage, or `undefined` when there is no such entry. */
export const triageEntry = (
  state: FrictionState,
  id: string,
  status: FrictionStatus
): FrictionEntry | undefined => {
  const index = state.entries.findIndex((entry) => entry.id === id);
  const entry = state.entries[index];
  if (entry === undefined) {
    return undefined;
  }
  const triaged: FrictionEntry = { ...entry, status };
  state.entries[index] = triaged;
  return triaged;
};

const SUMMARY_CHARS = 200;

/** What `list` returns: every entry, newest first, short enough to scan for a match before filing. */
export const listText = (
  entries: readonly FrictionEntry[],
  scope?: FrictionScope
): string => {
  const shown = entries
    .filter((entry) => scope === undefined || entry.scope === scope)
    .toReversed()
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      status: entry.status,
      title: entry.title,
      whatHappened:
        entry.whatHappened.length > SUMMARY_CHARS
          ? `${entry.whatHappened.slice(0, SUMMARY_CHARS)}…`
          : entry.whatHappened,
      notes: entry.notes.length,
    }));
  return JSON.stringify({ entries: shown });
};

const Scope = Type.Union([Type.Literal("platform"), Type.Literal("project")], {
  description:
    "platform: this agent environment, meaning its tools, sandbox, skills, prompts or harness. project: the person's own code, repository or workspace, meaning its build, scripts, types or docs.",
});

const FILING_BAR = [
  "File only friction that is all of: durable (it will still be there next session), recurring (not a one-off slip),",
  "owned (someone could clearly fix it) and a reproducible gap, such as a missing step, a type or doc that lies, a broken harness",
  "or script, docs that do not match the code.",
  "Confusion that ends with this session, your own mistakes, and the task being hard are not friction.",
].join(" ");

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

export const frictionExtension = (): Extension =>
  defineExtension({
    name: "friction",
    tools: [
      defineTool({
        name: "friction_list",
        description:
          "Read the friction log, the papercuts agents filed for the person to review, newest first. Read it before friction_add: when an entry already covers your pain, use friction_note on it instead.",
        parameters: Type.Object({
          scope: Type.Optional(Scope),
        }),
        replay: "safe",
        execute: async ({ scope }, api, context) => {
          const state = await api.snapshot(FrictionDoc, context);
          return {
            ...text(listText(state?.entries ?? [], scope)),
            details: {},
          };
        },
      }),
      defineTool({
        name: "friction_add",
        description: [
          "File a new entry in the friction log the person reviews later, about pain you hit while working in this platform or in the person's project.",
          FILING_BAR,
          "Call friction_list first and note a matching entry instead of adding a duplicate.",
          "Filing fixes nothing and does not reach the person now: keep working, and tell them in your answer if it blocks the task.",
        ].join(" "),
        parameters: Type.Object({
          scope: Scope,
          title: Type.String({
            description:
              "The gap in one line, such as 'pnpm test ignores --filter'",
            minLength: 1,
            maxLength: 120,
          }),
          whatHappened: Type.String({
            description:
              "What you did and what happened, with the command, error or file",
            minLength: 1,
            maxLength: 2000,
          }),
          expectedOrWhyItHurt: Type.String({
            description: "What you expected instead, or what it cost you",
            minLength: 1,
            maxLength: 2000,
          }),
        }),
        execute: async (input, api, context) => {
          const entry = await api.commit(
            async (tx) =>
              addEntry(
                await tx.doc(FrictionDoc),
                input,
                Number(api.conversationId),
                Date.now()
              ),
            context
          );
          if (entry === "full") {
            throw new Error(
              `The friction log is full: ${MAX_ENTRIES} entries wait for the person. Note an existing entry instead.`
            );
          }
          return {
            ...text(`Filed ${entry.id}: ${entry.title}`),
            details: { id: entry.id },
          };
        },
      }),
      defineTool({
        name: "friction_note",
        description:
          "Add a new occurrence or evidence to an existing friction log entry, by its id from friction_list. A note on a resolved entry reopens it.",
        parameters: Type.Object({
          id: Type.String({ description: "The entry's id, such as f3" }),
          note: Type.String({
            description: "The new occurrence or evidence",
            minLength: 1,
            maxLength: 2000,
          }),
        }),
        execute: async ({ id, note }, api, context) => {
          const entry = await api.commit(
            async (tx) =>
              noteEntry(
                await tx.doc(FrictionDoc),
                id,
                note,
                Number(api.conversationId),
                Date.now()
              ),
            context
          );
          if (entry === undefined) {
            throw new Error(
              `No friction entry ${id}; call friction_list for ids.`
            );
          }
          return {
            ...text(
              `Noted ${entry.id} (${entry.notes.length} ${entry.notes.length === 1 ? "note" : "notes"}, ${entry.status}).`
            ),
            details: { id: entry.id },
          };
        },
      }),
    ],
  });
