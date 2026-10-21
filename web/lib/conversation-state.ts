// The state of one conversation, folded from its pi-durable events. Pure, so it is unit-tested and easy to reshape
// when the UI moves from full detail to only the meaningful parts.
import type {
  AgentEvent,
  AssistantMessage,
  ConversationEvent,
  EntryRecord,
  HistoryPage,
  Message,
  MessageChange,
  QueuedInput,
  UnansweredInput,
  UsageState,
} from "effect-pi/api";

import type { AttachmentRef } from "./attachments";
import { boundaryNote } from "./boundary-note";
import { unansweredNote } from "./unanswered-note";

export interface ToolRun {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly details: unknown;
  readonly status: "pending" | "running" | "done";
}

/**
 * A message the person sent, shown before the server has placed it. The console sends it with `requestId`, which the
 * admitted submission carries back (its `submission` event, or the send's answer); `entry` is the transcript entry
 * that replaces it.
 */
export interface PendingInput {
  readonly requestId: string;
  /** What the person typed — the entry may differ (`/skill:` expands, attachment blocks are appended). */
  readonly prompt: string;
  /** Its files, as chips. */
  readonly attachments: readonly AttachmentRef[];
  /** The submission it was admitted as, once known. While absent the message reads "Sending…". */
  readonly submission?: number;
  /** The entry the submission placed, once known. */
  readonly entry?: number;
}

/**
 * Entries the latest head marker hides, paged in on demand from the history endpoint. Kept apart from `entries`,
 * which each snapshot replaces wholesale; this slice survives them.
 */
export interface EarlierHistory {
  /** Pages fetched so far plus entries a fresh head marker displaced, sorted by id (storage order). */
  readonly entries: readonly EntryRecord[];
  /**
   * The next page's `before`: the smallest id the last fetch returned, so fetched coverage walks contiguously down
   * from the bound. Displaced entries are display-only and never move it; a moved bound resets it (re-anchor at
   * the top) so newly hidden entries cannot leave a hole behind what is held.
   */
  readonly frontier: number | undefined;
  /** The newest hidden entry id the latest snapshot reported, or false when nothing is hidden. */
  readonly bound: number | false;
  /** Another page precedes what is loaded (the snapshot's `earlier`, then each page's). */
  readonly hasMore: boolean;
  /** A history request is in flight. */
  readonly loading: boolean;
}

export interface ConversationState {
  readonly entries: readonly EntryRecord[];
  /** Hidden history behind the latest head marker; see `EarlierHistory`. */
  readonly earlier: EarlierHistory;
  /** Sent inputs not yet in `entries`, in send order. */
  readonly pending: readonly PendingInput[];
  readonly streaming: AssistantMessage | undefined;
  readonly tools: Readonly<Record<string, ToolRun>>;
  readonly running: boolean;
  /** The inbox's queued submissions, in order, with each input's text. */
  readonly queue: readonly QueuedInput[];
  readonly usage: UsageState | undefined;
  readonly failures: readonly string[];
  /** User messages whose run ended without an answer, by entry id. */
  readonly unanswered: Readonly<Record<number, UnansweredInput>>;
  /** True once the stream's snapshot has landed: entries before it are history, after it they are new commits. */
  readonly hydrated: boolean;
}

export const initialState: ConversationState = {
  entries: [],
  earlier: {
    entries: [],
    frontier: undefined,
    bound: false,
    hasMore: false,
    loading: false,
  },
  pending: [],
  streaming: undefined,
  tools: {},
  running: false,
  queue: [],
  usage: undefined,
  failures: [],
  unanswered: {},
  hydrated: false,
};

/** The entry id is in the transcript — the active view, or paged-in earlier history. */
const hasEntry = (state: ConversationState, id: number): boolean =>
  state.entries.some((entry) => entry.id === id) ||
  state.earlier.entries.some((entry) => entry.id === id);

/**
 * Show a sent message as pending — unless its entry is already here, as when the answer to `create` lands after the
 * subscription's snapshot.
 */
export const withPending = (
  state: ConversationState,
  pending: PendingInput
): ConversationState =>
  pending.entry !== undefined && hasEntry(state, pending.entry)
    ? state
    : { ...state, pending: [...state.pending, pending] };

/** Drop a pending message without an answer: the send failed. */
export const withoutPending = (
  state: ConversationState,
  requestId: string
): ConversationState =>
  state.pending.some((pending) => pending.requestId === requestId)
    ? {
        ...state,
        pending: state.pending.filter(
          (pending) => pending.requestId !== requestId
        ),
      }
    : state;

/** The parts of a submission a pending input matches on: its `requestId`, and `entry` once placed. */
interface SubmissionHint {
  readonly requestId?: string | undefined;
  readonly id: number;
  readonly status: string;
  readonly entry?: number | undefined;
}

/**
 * Confirm the pending input a submission carries: it is no longer "Sending…". It is dropped once its entry is in the
 * transcript — normally the same commit — or when the input can no longer be answered.
 */
const withSubmission = (
  state: ConversationState,
  record: SubmissionHint
): ConversationState => {
  const index = state.pending.findIndex(
    (pending) => pending.requestId === record.requestId
  );
  if (record.requestId === undefined || index === -1) {
    return state;
  }
  if (
    record.status === "unanswered" ||
    (record.entry !== undefined && hasEntry(state, record.entry))
  ) {
    return {
      ...state,
      pending: state.pending.filter((_, i) => i !== index),
    };
  }
  return {
    ...state,
    pending: state.pending.map((pending, i) =>
      i === index
        ? {
            ...pending,
            submission: record.id,
            ...(record.entry === undefined ? {} : { entry: record.entry }),
          }
        : pending
    ),
  };
};

const withdrawnNote = (record: {
  readonly reason?: string | undefined;
  readonly detail?: UnansweredInput["detail"];
}): string =>
  record.reason === "aborted" || record.reason === undefined
    ? "Not sent: the run was stopped"
    : (unansweredNote({ reason: record.reason, detail: record.detail }) ??
      `Not answered: ${record.reason}`);

/**
 * A queued input withdrawn before it was placed (the run stopped, the conversation aborted) leaves no entry and no
 * transcript trace: its pending would vanish unexplained. The settled note names it.
 */
const withWithdrawn = (
  before: ConversationState,
  after: ConversationState,
  record: {
    readonly requestId?: string | undefined;
    readonly status: string;
    readonly entry?: number | undefined;
    readonly reason?: string | undefined;
    readonly detail?: UnansweredInput["detail"];
  }
): ConversationState =>
  record.status === "unanswered" &&
  record.entry === undefined &&
  record.requestId !== undefined &&
  before.pending.some((pending) => pending.requestId === record.requestId)
    ? { ...after, failures: [...after.failures, withdrawnNote(record)] }
    : after;

/** The send's answer names a pending's submission — the same fact its `submission` event may already have carried. */
export const withAck = (
  state: ConversationState,
  requestId: string,
  ack: {
    readonly id: number;
    readonly status: string;
    readonly entry?: number | undefined;
    readonly reason?: string | undefined;
    readonly detail?: string | undefined;
  }
): ConversationState =>
  withWithdrawn(
    state,
    withSubmission(state, {
      requestId,
      id: ack.id,
      status: ack.status,
      entry: ack.entry,
    }),
    { ...ack, requestId }
  );

/** Pending whose placed entry just arrived are dropped — the real entry shows instead. */
const withoutEntry = (
  pending: readonly PendingInput[],
  entry: number
): readonly PendingInput[] =>
  pending.some((p) => p.entry === entry)
    ? pending.filter((p) => p.entry !== entry)
    : pending;

const withEntry = (
  entries: readonly EntryRecord[],
  entry: EntryRecord
): readonly EntryRecord[] =>
  entries.some((e) => e.id === entry.id) ? entries : [...entries, entry];

/** "Show earlier entries" is fetching a page. */
export const withEarlierLoading = (
  state: ConversationState,
  loading: boolean
): ConversationState =>
  state.earlier.loading === loading
    ? state
    : { ...state, earlier: { ...state.earlier, loading } };

/**
 * One fetched history page, folded in: its entries merge into the held set sorted by id, deduped by id against
 * both lists — a page fetched after a new marker committed but before its snapshot can repeat entries still in
 * the active transcript. `frontier` keeps the next `before` at the smallest fetched id, never a displaced entry,
 * so paging always walks contiguously down from the bound.
 */
export const withEarlierPage = (
  state: ConversationState,
  page: HistoryPage
): ConversationState => {
  const held = new Set<number>([
    ...state.entries.map((entry) => entry.id),
    ...state.earlier.entries.map((entry) => entry.id),
  ]);
  return {
    ...state,
    earlier: {
      ...state.earlier,
      entries: [
        ...state.earlier.entries,
        ...page.entries.filter((entry) => !held.has(entry.id)),
      ].toSorted((a, b) => Number(a.id) - Number(b.id)),
      frontier:
        page.entries.length === 0
          ? state.earlier.frontier
          : Number(page.entries[0].id),
      hasMore: page.earlier,
      loading: false,
    },
  };
};

const applyChange = (
  message: AssistantMessage,
  change: MessageChange
): AssistantMessage => {
  if (change.type === "message") {
    return change.message;
  }
  const content = [...message.content];
  const block = content[change.contentIndex];
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block": {
      content[change.contentIndex] = change.block;
      break;
    }
    case "text_delta": {
      if (block?.type === "text") {
        content[change.contentIndex] = {
          ...block,
          text: block.text + change.delta,
        };
      }
      break;
    }
    case "thinking_delta": {
      if (block?.type === "thinking") {
        content[change.contentIndex] = {
          ...block,
          thinking: block.thinking + change.delta,
        };
      }
      break;
    }
    case "toolcall_delta": {
      // Partial JSON; the complete arguments arrive with the `block` change and tool_execution_start.
      break;
    }
    default: {
      break;
    }
  }
  return { ...message, content };
};

type OutputUpdate = Extract<
  AgentEvent,
  { type: "tool_execution_update" }
>["output"];

const applyOutput = (output: string, update: OutputUpdate): string => {
  if (update === undefined) {
    return output;
  }
  if ("set" in update) {
    return update.set;
  }
  return output.slice(update.trimStart ?? 0) + (update.append ?? "");
};

const applySnapshot = (
  state: ConversationState,
  event: Extract<ConversationEvent, { type: "snapshot" }>
): ConversationState => {
  // Pendings keep only what the fresh view cannot account for: a queued one survives while still in the inbox;
  // a placed one's entry is in `entries` — or is out of view, then the transcript is right without it.
  const inbox = new Set<number>(event.inbox.map((item) => item.id));
  // A fresh head marker pushes active entries out of the view; they join the earlier history so the transcript
  // keeps them. The slice is sorted by id — a displaced marker's id is larger than the retained entries', and a
  // fetched page can be older or newer than either.
  const held = new Set<number>([
    ...event.entries.map((entry) => entry.id),
    ...state.earlier.entries.map((entry) => entry.id),
  ]);
  const displaced = state.entries.filter((entry) => !held.has(entry.id));
  const bound = event.earlier;
  // bound === false: nothing is hidden — no head marker, or a restarted server reused this id for a different
  // conversation — so any entries already paged in are stale.
  const earlier =
    bound === false
      ? { ...initialState.earlier, loading: state.earlier.loading }
      : {
          entries: [...state.earlier.entries, ...displaced].toSorted(
            (a, b) => Number(a.id) - Number(b.id)
          ),
          // The bound moved — a marker landed since the last snapshot: re-anchor so the range it newly hides
          // refetches from the top instead of leaving a hole above what is held.
          frontier:
            bound === state.earlier.bound ? state.earlier.frontier : undefined,
          bound,
          hasMore: true,
          loading: state.earlier.loading,
        };
  return {
    ...initialState,
    entries: event.entries,
    earlier,
    pending: state.pending.filter(
      (pending) =>
        pending.submission === undefined ||
        (pending.entry === undefined && inbox.has(pending.submission))
    ),
    streaming: event.generation?.message,
    running: event.run !== undefined,
    queue: event.inbox,
    usage: event.usage,
    hydrated: true,
    unanswered: Object.fromEntries(
      event.unanswered.map((input) => [input.entry, input])
    ),
    tools: Object.fromEntries(
      event.tools.map((slot) => [
        slot.callId,
        {
          callId: slot.callId,
          name: slot.name,
          output: slot.output ?? "",
          details: slot.details,
          status: slot.status,
        },
      ])
    ),
  };
};

const withTool = (
  state: ConversationState,
  callId: string,
  name: string,
  change: (tool: ToolRun) => ToolRun
): ConversationState => {
  const tool = state.tools[callId] ?? {
    callId,
    name,
    output: "",
    details: undefined,
    status: "running" as const,
  };
  return { ...state, tools: { ...state.tools, [callId]: change(tool) } };
};

/** A submission that settled: an input left without an answer is kept, by its entry. */
const withSettled = (
  state: ConversationState,
  record: Extract<AgentEvent, { type: "submission" }>["record"]
): ConversationState =>
  record.type === "input" &&
  record.status === "unanswered" &&
  record.entry !== undefined
    ? {
        ...state,
        unanswered: {
          ...state.unanswered,
          [record.entry]: {
            entry: record.entry,
            reason: record.reason,
            ...(record.detail === undefined ? {} : { detail: record.detail }),
          },
        },
      }
    : state;

const applySubmission = (
  state: ConversationState,
  event: Extract<ConversationEvent, { type: "submission" }>
): ConversationState => {
  const { record } = event;
  const next = withSubmission(withSettled(state, record), {
    requestId: record.requestId,
    id: record.id,
    status: record.status,
    entry:
      record.status === "placed" || record.status === "done"
        ? record.entry
        : undefined,
  });
  return record.type === "input" ? withWithdrawn(state, next, record) : next;
};

export const applyEvent = (
  state: ConversationState,
  event: ConversationEvent
): ConversationState => {
  switch (event.type) {
    case "snapshot": {
      return applySnapshot(state, event);
    }
    case "run_start": {
      return { ...state, running: true };
    }
    case "run_end": {
      return { ...state, running: false };
    }
    case "message_start": {
      return event.message.role === "assistant"
        ? { ...state, streaming: event.message }
        : state;
    }
    case "message_update": {
      if (state.streaming === undefined) {
        return state;
      }
      let { streaming } = state;
      for (const change of event.changes) {
        streaming = applyChange(streaming, change);
      }
      return { ...state, streaming };
    }
    case "message_end": {
      return {
        ...state,
        streaming: undefined,
        entries: withEntry(state.entries, event.entry),
        pending: withoutEntry(state.pending, event.entry.id),
      };
    }
    case "entry_appended": {
      return {
        ...state,
        entries: withEntry(state.entries, event.entry),
        pending: withoutEntry(state.pending, event.entry.id),
      };
    }
    case "tool_execution_start": {
      return withTool(state, event.toolCallId, event.toolName, (tool) => ({
        ...tool,
        status: "running",
      }));
    }
    case "tool_execution_update": {
      return withTool(state, event.toolCallId, event.toolName, (tool) => ({
        ...tool,
        output: applyOutput(tool.output, event.output),
        details: event.details ?? tool.details,
      }));
    }
    case "tool_execution_end": {
      const ended = withTool(
        state,
        event.toolCallId,
        event.toolName,
        (tool) => ({
          ...tool,
          status: "done",
        })
      );
      return event.entry === undefined
        ? ended
        : { ...ended, entries: withEntry(ended.entries, event.entry) };
    }
    case "inbox_update": {
      return { ...state, queue: event.items };
    }
    case "usage_changed": {
      return { ...state, usage: event.usage };
    }
    case "submission": {
      return applySubmission(state, event);
    }
    case "task_failed": {
      return {
        ...state,
        failures: [...state.failures, event.message],
      };
    }
    default: {
      return state;
    }
  }
};

/** The committed entry carrying a call's tool result, once there is one; its `data` holds the diagnostics. */
export const toolResultEntryOf = (
  state: ConversationState,
  callId: string
): EntryRecord | undefined =>
  // Paged-in history holds the calls compaction hid — their results live there too.
  [...state.entries, ...state.earlier.entries].find((entry) =>
    (entry.model ?? []).some(
      (m) => m.role === "toolResult" && m.toolCallId === callId
    )
  );

/** The committed tool result message for a call, once there is one. */
export const toolResultOf = (
  state: ConversationState,
  callId: string
): Extract<Message, { role: "toolResult" }> | undefined =>
  toolResultEntryOf(state, callId)?.model?.find(
    (m): m is Extract<Message, { role: "toolResult" }> =>
      m.role === "toolResult" && m.toolCallId === callId
  );

/**
 * The simple view's grouping of a transcript span: the person's own messages stand alone; everything between
 * them — the run's thinking, tool calls, boundary rows — folds into one expandable block.
 */
export type SimpleItem =
  | { readonly kind: "message"; readonly entry: EntryRecord }
  | { readonly kind: "run"; readonly entries: readonly EntryRecord[] };

/**
 * Group `entries` into `SimpleItem`s: a user entry that is not a boundary (a head marker carries a user-role
 * message, but it is not something the person sent) breaks the run.
 */
export const groupSimple = (
  entries: readonly EntryRecord[]
): readonly SimpleItem[] => {
  const items: SimpleItem[] = [];
  let run: EntryRecord[] = [];
  const flush = () => {
    if (run.length > 0) {
      items.push({ kind: "run", entries: run });
      run = [];
    }
  };
  for (const entry of entries) {
    if (
      entry.model?.[0]?.role === "user" &&
      boundaryNote(entry) === undefined
    ) {
      flush();
      items.push({ kind: "message", entry });
    } else {
      run.push(entry);
    }
  }
  flush();
  return items;
};

/** A run's closing answer: the last text block of its last assistant entry that has one. */
export const finalResponse = (
  entries: readonly EntryRecord[]
): { readonly entry: EntryRecord; readonly text: string } | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const message = entry?.model?.[0];
    if (message?.role !== "assistant") {
      continue;
    }
    const text = message.content.findLast((block) => block.type === "text");
    if (text !== undefined && text.type === "text") {
      return { entry, text: text.text };
    }
  }
  return undefined;
};

export const totalUsage = (usage: UsageState | undefined) => {
  let tokens = 0;
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) {
    tokens += u.totalTokens;
    cost += u.cost.total;
  }
  return { tokens, cost };
};
