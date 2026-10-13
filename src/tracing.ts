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
  services: Context.Context<never>
): AgentTracing => {
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
            "langfuse.observation.input": traceJson(request.messages),
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
            "langfuse.observation.input": traceJson(call.arguments),
          });
        },
        afterTool: (_call, result, api) => {
          // A tool that throws has no content; its message is in the diagnostics.
          const errors = (result.diagnostics ?? [])
            .filter((diagnostic) => diagnostic.severity === "error")
            .map((diagnostic) => diagnostic.message);
          end(
            api.taskId,
            {
              "langfuse.observation.output": traceJson(
                result.content === undefined || result.content.length === 0
                  ? errors
                  : result.content
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
