// Tracing for agents: every model request and tool call becomes an Effect span, nested under the `ask` that caused
// it, with the attributes Langfuse reads (https://langfuse.com/integrations/native/opentelemetry). pi-durable runs
// generations and tools in its own scheduler, outside any Effect fiber, so its hooks open and close the spans, and the
// parent comes from the conversation: an `ask` registers its span for its conversation.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Extension,
  TaskId,
} from "@earendil-works/pi-durable";
import { Clock, Effect, Exit } from "effect";
import type { Context, Tracer } from "effect";

/** Base64 payloads longer than this are replaced by their size, so screenshots do not bloat the traces. */
const MAX_INLINE_DATA = 256;

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
  // Langfuse session per conversation. Conversation ids restart with every process (MemoryStorage), so a
  // per-process prefix keeps runs apart.
  const runId = crypto.randomUUID().slice(0, 8);
  const sessionOf = (conversationId: ConversationId) =>
    `${runId}-${conversationId}`;
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
    attributes: Record<string, unknown>
  ) => {
    // A request retried after recovery opens again; the abandoned attempt ends here.
    end(taskId, {}, false);
    const parent = parents.get(conversationId);
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
    open.set(taskId, span);
  };

  const extension = defineExtension({
    name: "tracing",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (
          request: { readonly messages: readonly Message[] },
          api
        ) => {
          start(api.taskId, api.conversationId, "generation", {
            "langfuse.observation.type": "generation",
            "langfuse.observation.input": traceJson(forTrace(request.messages)),
          });
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
        beforeTool: (call, api) => {
          start(api.taskId, api.conversationId, `tool ${call.name}`, {
            "langfuse.observation.type": "tool",
            "gen_ai.tool.name": call.name,
            "langfuse.observation.input": traceJson(
              forTraceArgs(call.name, call.arguments)
            ),
          });
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
  };
};
