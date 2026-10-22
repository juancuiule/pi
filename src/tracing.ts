// Tracing for agents: every model request and tool call becomes an Effect span, nested under the `ask` that caused
// it, with the attributes Langfuse reads (https://langfuse.com/integrations/native/opentelemetry). pi-durable runs
// generations and tools in its own scheduler, outside any Effect fiber, so its hooks open and close the spans, and the
// parent comes from the conversation: an `ask` registers its span for its conversation, and a subagent's conversation
// takes the span of the tool call that created it.
import type { Context as ChordContext } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Extension,
  HookApi,
  TaskId,
} from "@earendil-works/pi-durable";
import { Clock, Effect, Exit, Tracer } from "effect";
import type { Context } from "effect";

/** Base64 payloads longer than this are replaced by their size, so screenshots do not bloat the traces. */
const MAX_INLINE_DATA = 256;

/**
 * Each run's OTEL trace id under the generation task that owned the run (`String(taskId)` → `traceId`), so a
 * message's feedback can be scored onto the trace that produced it.
 */
export const TraceDoc = defineDoc<{
  readonly traces: Record<string, string>;
}>({
  kind: "app.trace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ traces: {} }),
});

/** JSON for span attributes, with images and other large base64 data left out. */
export const traceJson = (value: unknown): string =>
  JSON.stringify(value, (key, field: unknown) =>
    key === "data" &&
    typeof field === "string" &&
    field.length > MAX_INLINE_DATA
      ? `[${field.length} base64 characters]`
      : field
  );

/** Tools whose results are attachment text. */
const ATTACHMENT_TOOLS = new Set(["read_attachment", "search_attachment"]);

/** Tools whose arguments carry a page's HTML. */
const ARTIFACT_TOOLS = new Set(["artifact_create", "artifact_update"]);

const sizeOf = (text: string) =>
  `[${text.length} characters of attachment text]`;

const sizeOfHtml = (text: string) => `[${text.length} characters of HTML]`;

/** An artifact tool's arguments for a trace, with the page and the edits' text replaced by their sizes. */
export const redactArtifactArguments = (
  tool: string,
  args: unknown
): unknown => {
  if (!ARTIFACT_TOOLS.has(tool) || args === null || typeof args !== "object") {
    return args;
  }
  const redacted = { ...(args as Record<string, unknown>) };
  if (typeof redacted.html === "string") {
    redacted.html = sizeOfHtml(redacted.html);
  }
  if (Array.isArray(redacted.edits)) {
    redacted.edits = redacted.edits.map((edit) => {
      if (edit === null || typeof edit !== "object") {
        return edit;
      }
      const pair = { ...(edit as Record<string, unknown>) };
      if (typeof pair.find === "string") {
        pair.find = sizeOfHtml(pair.find);
      }
      if (typeof pair.replace === "string") {
        pair.replace = sizeOfHtml(pair.replace);
      }
      return pair;
    });
  }
  return redacted;
};

/** Message text with each `<attachment>` block's contents replaced by their size. */
export const redactAttachmentBlocks = (text: string): string =>
  text.replaceAll(
    /(?<open><attachment [^>\n]*>)\n(?<body>[\s\S]*?)\n<\/attachment>/gu,
    (...match: unknown[]) => {
      const { open, body } = match.at(-1) as { open: string; body: string };
      return `${open}\n${sizeOf(body)}\n</attachment>`;
    }
  );

/** Messages for a trace, with the files people attached left out: their blocks, and what the tools read of them. */
export const redactAttachments = (
  messages: readonly Message[]
): readonly Message[] =>
  messages.map((message): Message => {
    if (message.role === "user") {
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? redactAttachmentBlocks(message.content)
            : message.content.map((block) =>
                block.type === "text"
                  ? { ...block, text: redactAttachmentBlocks(block.text) }
                  : block
              ),
      };
    }
    if (
      message.role === "toolResult" &&
      ATTACHMENT_TOOLS.has(message.toolName)
    ) {
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "text" ? { ...block, text: sizeOf(block.text) } : block
        ),
      };
    }
    return message;
  });

/** Langfuse attributes for one model response. */
export const generationAttributes = (
  message: AssistantMessage
): Record<string, unknown> => ({
  "langfuse.observation.model.name": message.model,
  "gen_ai.system": message.provider,
  "langfuse.observation.output": traceJson(message.content),
  "langfuse.observation.usage_details": JSON.stringify({
    input: message.usage.input,
    output: message.usage.output,
    cache_read: message.usage.cacheRead,
    cache_write: message.usage.cacheWrite,
  }),
  "langfuse.observation.cost_details": JSON.stringify({
    total: message.usage.cost.total,
  }),
  "gen_ai.response.finish_reasons": [message.stopReason],
  ...(message.errorMessage === undefined
    ? {}
    : {
        "langfuse.observation.level": "ERROR",
        "langfuse.observation.status_message": message.errorMessage,
      }),
});

export interface AgentTracing {
  /** Hooks that trace model requests and tool calls; selected by every conversation. */
  readonly extension: Extension;
  /** Run `effect` with its span as the parent of the conversation's model requests and tool calls. */
  traced<A, E, R>(
    conversationId: ConversationId,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R>;
  /** The Langfuse session of a conversation: unique per process, since conversation ids restart with each run. */
  sessionOf(conversationId: ConversationId): string;
  /** A subagent's conversation: its spans go under the tool call that created it, in its owner's session. */
  childConversation(
    conversationId: ConversationId,
    owner: { readonly conversationId: ConversationId; readonly taskId: TaskId }
  ): void;
}

/**
 * Tracing that creates spans with the tracer in `services`. Without an exporter that is Effect's default tracer, so
 * spans cost little and go nowhere.
 */
export const makeAgentTracing = (
  services: Context.Context<never>,
  options: {
    /** Keep the text of attachments in traces; left out (only its size) by default. */
    readonly attachmentText?: boolean;
    /**
     * How a generation task's trace is committed to TraceDoc: filled in by the caller once the harness exists,
     * since this tracing is built before it. Errors thrown here are caught by the hook that awaits it.
     */
    readonly traceWrites?: {
      record?: (
        conversationId: ConversationId,
        taskId: TaskId,
        traceId: string,
        context: ChordContext
      ) => Promise<void>;
    };
  } = {}
): AgentTracing => {
  const forTrace = (messages: readonly Message[]) =>
    options.attachmentText === true ? messages : redactAttachments(messages);
  const forTraceArgs = (tool: string, args: unknown) =>
    options.attachmentText === true
      ? args
      : redactArtifactArguments(tool, args);
  const redactsTool = (tool: string) =>
    options.attachmentText !== true && ATTACHMENT_TOOLS.has(tool);
  const forTraceResult = <B extends { readonly type: string }>(
    tool: string,
    content: readonly B[]
  ) =>
    redactsTool(tool)
      ? content.map((block) =>
          "text" in block && typeof block.text === "string"
            ? { ...block, text: sizeOf(block.text) }
            : block
        )
      : content;
  const run = Effect.runSyncWith(services);
  const parents = new Map<ConversationId, Tracer.AnySpan>();
  // A send's Run has no asking span: the first span of each Run adopts the root role instead, kept as its ids
  // (the root ends before the Run's later spans start, so they hold an ExternalSpan to it, not the span).
  const runs = new Map<
    ConversationId,
    { key: string; traceId: string; spanId: string }
  >();
  // The Run a conversation is in, named by its first input — stable across handOver and mid-Run pushes.
  // Under `ask` the asking span parents everything anyway, so `parents` skips the read entirely.
  const runKeyOf = async (api: HookApi, context: ChordContext) => {
    if (parents.get(api.conversationId) !== undefined) {
      return;
    }
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    return live?.run === undefined ? undefined : String(live.run.inputs[0]);
  };
  // Generation tasks whose trace was already committed to TraceDoc, so only their first request writes.
  const recorded = new Set<TaskId>();
  // Langfuse session per conversation: a subagent's conversation joins the session of the conversation it serves.
  // Conversation ids restart with every process (MemoryStorage), so a per-process prefix keeps runs apart.
  const runId = crypto.randomUUID().slice(0, 8);
  const sessions = new Map<ConversationId, string>();
  const sessionOf = (conversationId: ConversationId) =>
    sessions.get(conversationId) ?? `${runId}-${conversationId}`;
  // One open span per task: a generation task makes one request at a time, a tool task is one call.
  const open = new Map<TaskId, Tracer.Span>();

  const end = (
    taskId: TaskId,
    attributes: Record<string, unknown>,
    ok: boolean
  ) => {
    const span = open.get(taskId);
    if (span === undefined) {
      return;
    }
    open.delete(taskId);
    for (const [key, value] of Object.entries(attributes)) {
      span.attribute(key, value);
    }
    span.end(run(Clock.currentTimeNanos), ok ? Exit.void : Exit.fail("failed"));
  };

  const start = (
    taskId: TaskId,
    conversationId: ConversationId,
    name: string,
    attributes: Record<string, unknown>,
    runKey: string | undefined
  ) => {
    // A request retried after recovery opens again; the abandoned attempt ends here.
    end(taskId, {}, false);
    let parent = parents.get(conversationId);
    // No asking span (a send-driven Run): the Run's first span becomes its trace's root; its other spans
    // adopt that root through `runKey`, which names the Run by its first input — stable across handOver
    // and mid-Run pushes. A different `runKey` is a new Run, and its first span replaces the root.
    let adoptKey: string | undefined;
    if (parent === undefined && runKey !== undefined) {
      const root = runs.get(conversationId);
      if (root !== undefined && root.key === runKey) {
        parent = Tracer.externalSpan({
          traceId: root.traceId,
          spanId: root.spanId,
        });
      } else {
        adoptKey = runKey;
      }
    }
    const span = run(
      Effect.makeSpan(name, {
        attributes: {
          ...attributes,
          "langfuse.session.id": sessionOf(conversationId),
        },
        kind: "internal",
        ...(parent === undefined ? {} : { parent }),
      })
    );
    if (adoptKey !== undefined) {
      runs.set(conversationId, {
        key: adoptKey,
        traceId: span.traceId,
        spanId: span.spanId,
      });
    }
    open.set(taskId, span);
    return span;
  };

  const extension = defineExtension({
    name: "tracing",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (
          request: { readonly messages: readonly Message[] },
          api,
          context
        ) => {
          const span = start(
            api.taskId,
            api.conversationId,
            "generation",
            {
              "langfuse.observation.type": "generation",
              "langfuse.observation.input": traceJson(
                forTrace(request.messages)
              ),
            },
            await runKeyOf(api, context)
          );
          // Once per generation task — the task that produced a message's run — record its trace so feedback
          // finds it. A failed write must not break the request (hooks.each reports and swallows it anyway).
          if (!recorded.has(api.taskId)) {
            recorded.add(api.taskId);
            try {
              await options.traceWrites?.record?.(
                api.conversationId,
                api.taskId,
                span.traceId,
                context
              );
            } catch {
              // A retry's next request writes again; the request still runs either way.
              recorded.delete(api.taskId);
            }
          }
        },
        afterResponse: (message, api) => {
          end(
            api.taskId,
            generationAttributes(message),
            message.stopReason !== "error"
          );
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          start(
            api.taskId,
            api.conversationId,
            `tool ${call.name}`,
            {
              "langfuse.observation.type": "tool",
              "gen_ai.tool.name": call.name,
              "langfuse.observation.input": traceJson(
                forTraceArgs(call.name, call.arguments)
              ),
            },
            await runKeyOf(api, context)
          );
        },
        afterTool: (call, result, api) => {
          // A tool that throws has no content; its message is in the diagnostics.
          // An attachment tool's diagnostics may quote the file too; they get the same treatment as its results.
          const errors = (result.diagnostics ?? [])
            .filter((diagnostic) => diagnostic.severity === "error")
            .map((diagnostic) =>
              redactsTool(call.name)
                ? sizeOf(diagnostic.message)
                : diagnostic.message
            );
          end(
            api.taskId,
            {
              "langfuse.observation.output": traceJson(
                result.content === undefined || result.content.length === 0
                  ? errors
                  : forTraceResult(call.name, result.content)
              ),
              ...(result.isError
                ? {
                    "langfuse.observation.level": "ERROR",
                    "langfuse.observation.status_message": errors.join("\n"),
                  }
                : {}),
            },
            !result.isError
          );
        },
      }),
    ],
  });

  return {
    extension,
    sessionOf,
    traced: (conversationId, effect) =>
      Effect.flatMap(Effect.currentSpan.pipe(Effect.option), (span) => {
        if (span._tag === "Some") {
          parents.set(conversationId, span.value);
        }
        return effect.pipe(
          Effect.ensuring(Effect.sync(() => parents.delete(conversationId)))
        );
      }),
    childConversation: (conversationId, owner) => {
      sessions.set(conversationId, sessionOf(owner.conversationId));
      const parent = open.get(owner.taskId);
      if (parent !== undefined) {
        parents.set(conversationId, parent);
      }
    },
  };
};
