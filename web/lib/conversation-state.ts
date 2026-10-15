// The state of one conversation, folded from its pi-durable events. Pure, so it is unit-tested and easy to reshape
// when the UI moves from full detail to only the meaningful parts.
import type {
  AgentEvent,
  AssistantMessage,
  ConversationEvent,
  EntryRecord,
  Message,
  MessageChange,
  UnansweredInput,
  UsageState,
} from "effect-pi/api";

import type { AttachmentRef } from "./attachments";

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

export interface ConversationState {
  readonly entries: readonly EntryRecord[];
  /** Sent inputs not yet in `entries`, in send order. */
  readonly pending: readonly PendingInput[];
  readonly streaming: AssistantMessage | undefined;
  readonly tools: Readonly<Record<string, ToolRun>>;
  readonly running: boolean;
  readonly queued: number;
  readonly usage: UsageState | undefined;
  readonly failures: readonly string[];
  /** User messages whose run ended without an answer, by entry id. */
  readonly unanswered: Readonly<Record<number, UnansweredInput>>;
}

export const initialState: ConversationState = {
  entries: [],
  pending: [],
  streaming: undefined,
  tools: {},
  running: false,
  queued: 0,
  usage: undefined,
  failures: [],
  unanswered: {},
};

/**
 * Show a sent message as pending — unless its entry is already here, as when the answer to `create` lands after the
 * subscription's snapshot.
 */
export const withPending = (
  state: ConversationState,
  pending: PendingInput
): ConversationState =>
  pending.entry !== undefined &&
  state.entries.some((entry) => entry.id === pending.entry)
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
    (record.entry !== undefined &&
      state.entries.some((entry) => entry.id === record.entry))
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

/** The send's answer names a pending's submission — the same fact its `submission` event may already have carried. */
export const withAck = (
  state: ConversationState,
  requestId: string,
  ack: { readonly id: number; readonly entry?: number | undefined }
): ConversationState =>
  withSubmission(state, {
    requestId,
    id: ack.id,
    status: ack.entry === undefined ? "queued" : "placed",
    entry: ack.entry,
  });

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
  return {
    ...initialState,
    entries: event.entries,
    pending: state.pending.filter(
      (pending) =>
        pending.submission === undefined ||
        (pending.entry === undefined && inbox.has(pending.submission))
    ),
    streaming: event.generation?.message,
    running: event.run !== undefined,
    queued: event.inbox.length,
    usage: event.usage,
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
  return withSubmission(withSettled(state, record), {
    requestId: record.requestId,
    id: record.id,
    status: record.status,
    entry:
      record.status === "placed" || record.status === "done"
        ? record.entry
        : undefined,
  });
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
      return { ...state, queued: event.items.length };
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
        failures: [...state.failures, `${event.kind}: ${event.message}`],
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
  state.entries.find((entry) =>
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

export const totalUsage = (usage: UsageState | undefined) => {
  let tokens = 0;
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) {
    tokens += u.totalTokens;
    cost += u.cost.total;
  }
  return { tokens, cost };
};
