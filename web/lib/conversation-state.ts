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

export interface ToolRun {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly details: unknown;
  readonly status: "pending" | "running" | "done";
  /**
   * When the client saw the call start and end (epoch ms), for its duration on the line. The events carry no
   * timestamps, so a slot restored from a snapshot — including one still running — has neither, and shows none.
   */
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface ConversationState {
  readonly entries: readonly EntryRecord[];
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
  streaming: undefined,
  tools: {},
  running: false,
  queued: 0,
  usage: undefined,
  failures: [],
  unanswered: {},
};

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

const startTool = (
  state: ConversationState,
  event: Extract<AgentEvent, { type: "tool_execution_start" }>,
  now: number
): ConversationState =>
  withTool(state, event.toolCallId, event.toolName, (tool) => ({
    ...tool,
    status: "running",
    startedAt: tool.startedAt ?? now,
  }));

const endTool = (
  state: ConversationState,
  event: Extract<AgentEvent, { type: "tool_execution_end" }>,
  now: number
): ConversationState => {
  const ended = withTool(state, event.toolCallId, event.toolName, (tool) => ({
    ...tool,
    status: "done",
    endedAt: tool.endedAt ?? now,
  }));
  return event.entry === undefined
    ? ended
    : { ...ended, entries: withEntry(ended.entries, event.entry) };
};

export const applyEvent = (
  state: ConversationState,
  event: ConversationEvent,
  now = Date.now()
): ConversationState => {
  switch (event.type) {
    case "snapshot": {
      return {
        ...initialState,
        entries: event.entries,
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
      };
    }
    case "entry_appended": {
      return { ...state, entries: withEntry(state.entries, event.entry) };
    }
    case "tool_execution_start": {
      return startTool(state, event, now);
    }
    case "tool_execution_update": {
      return withTool(state, event.toolCallId, event.toolName, (tool) => ({
        ...tool,
        output: applyOutput(tool.output, event.output),
        details: event.details ?? tool.details,
      }));
    }
    case "tool_execution_end": {
      return endTool(state, event, now);
    }
    case "inbox_update": {
      return { ...state, queued: event.items.length };
    }
    case "usage_changed": {
      return { ...state, usage: event.usage };
    }
    case "submission": {
      return withSettled(state, event.record);
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
