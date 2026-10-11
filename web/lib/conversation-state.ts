// The state of one conversation, folded from its pi-durable events. Pure, so it is unit-tested and easy to reshape
// when the UI moves from full detail to only the meaningful parts.
import type {
  AgentEvent,
  AssistantMessage,
  EntryRecord,
  Message,
  MessageChange,
  UsageState,
} from "effect-pi/api";

export interface ToolRun {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly details: unknown;
  readonly status: "pending" | "running" | "done";
}

export interface ConversationState {
  readonly entries: readonly EntryRecord[];
  readonly streaming: AssistantMessage | undefined;
  readonly tools: Readonly<Record<string, ToolRun>>;
  readonly running: boolean;
  readonly queued: number;
  readonly usage: UsageState | undefined;
  readonly failures: readonly string[];
}

export const initialState: ConversationState = {
  entries: [],
  streaming: undefined,
  tools: {},
  running: false,
  queued: 0,
  usage: undefined,
  failures: [],
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

export const applyEvent = (
  state: ConversationState,
  event: AgentEvent
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

/** The committed tool result message for a call, once there is one. */
export const toolResultOf = (
  state: ConversationState,
  callId: string
): Message | undefined =>
  state.entries
    .flatMap((entry) => entry.model ?? [])
    .find((m) => m.role === "toolResult" && m.toolCallId === callId);

export const totalUsage = (usage: UsageState | undefined) => {
  let tokens = 0;
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) {
    tokens += u.totalTokens;
    cost += u.cost.total;
  }
  return { tokens, cost };
};
