// Tracing for agents: every model request and tool call becomes an Effect span, nested under the `ask` that caused
// it or under the `turn` root of its Run, with the attributes Langfuse reads
// (https://langfuse.com/integrations/native/opentelemetry). pi-durable runs generations and tools in its own
// scheduler, outside any Effect fiber, so its hooks open and close the spans, and the parent comes from the
// conversation: an `ask` registers its span for its conversation, a subagent's conversation takes the span of the tool
// call that created it, and a send-driven Run opens its own root.
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
  SettledSubmissionRecord,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import { Clock, Effect, Exit } from "effect";
import type { Context, Tracer } from "effect";

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

/** A message's text, without images or other blocks. */
const textOf = (
  content:
    | string
    | readonly { readonly type: string; readonly text?: unknown }[]
): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((block) =>
          block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : []
        )
        .join("\n");

/** What a Run's trace is filtered by in Langfuse: put on every span of the Run, as Langfuse asks. */
export interface RunDescription {
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

const runAttributes = (description: RunDescription | undefined) =>
  description === undefined
    ? {}
    : {
        "langfuse.trace.tags": description.tags,
        ...Object.fromEntries(
          Object.entries(description.metadata).map(([key, value]) => [
            `langfuse.trace.metadata.${key}`,
            value,
          ])
        ),
      };

/** What tracing needs from the harness, which is built after it. */
export interface TraceHooks {
  record?: (
    conversationId: ConversationId,
    taskId: TaskId,
    traceId: string,
    context: ChordContext
  ) => Promise<void>;
  describe?: (
    conversationId: ConversationId,
    context: ChordContext
  ) => Promise<RunDescription>;
  /** How a Run ended: the settlement of its first input, which pi-durable settles with all of the Run's inputs. */
  settled?: (
    submissionId: SubmissionId
  ) => Promise<SettledSubmissionRecord | undefined>;
}

/** The level and status a `turn` ends with: a stop is not an error, a failure carries pi-durable's reason. */
const runEnd = (settlement: SettledSubmissionRecord | undefined) => {
  if (settlement === undefined || settlement.status === "done") {
    return { attributes: {}, ok: true };
  }
  if (settlement.reason === "aborted") {
    return {
      attributes: {
        "langfuse.observation.level": "WARNING",
        "langfuse.observation.status_message": "Stopped before answering",
      },
      ok: true,
    };
  }
  return {
    attributes: {
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message":
        typeof settlement.detail === "string"
          ? settlement.detail
          : settlement.reason,
    },
    ok: false,
  };
};

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
  /** The `turn` root of the conversation's latest send-driven Run, ended or not; this process's only. */
  lastTurn(conversationId: ConversationId): Tracer.Span | undefined;
  /** A subagent's conversation: its spans go under the tool call that created it, in its owner's session. */
  childConversation(
    conversationId: ConversationId,
    owner: { readonly conversationId: ConversationId; readonly taskId: TaskId }
  ): void;
}

// The Run a conversation is in, named by its first input — stable across handOver and mid-Run pushes.
const runKeyOf = async (api: HookApi, context: ChordContext) => {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  return live?.run?.inputs[0];
};

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
     * How a generation task's trace is committed to TraceDoc, and how a Run is described: filled in by the caller
     * once the harness exists, since this tracing is built before it. Errors thrown here are caught by the hooks.
     */
    readonly traceHooks?: TraceHooks;
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
  // A Run's input for its root: what the person sent last, attachments left out unless kept.
  const lastUserText = (messages: readonly Message[]) => {
    const user = forTrace(messages).findLast(
      (message) => message.role === "user"
    );
    return user === undefined ? undefined : textOf(user.content);
  };
  const run = Effect.runSyncWith(services);
  const parents = new Map<ConversationId, Tracer.AnySpan>();
  // Generation tasks whose trace was already committed to TraceDoc, so only their first request writes.
  const recorded = new Set<TaskId>();
  // Langfuse session per conversation: a subagent's conversation joins the session of the conversation it serves.
  // Conversation ids restart with every process (MemoryStorage), so a per-process prefix keeps runs apart.
  const runId = crypto.randomUUID().slice(0, 8);
  const sessions = new Map<ConversationId, string>();
  const sessionOf = (conversationId: ConversationId) =>
    sessions.get(conversationId) ?? `${runId}-${conversationId}`;
  // One open span per task: a generation task makes one request at a time, a tool task is one call. `root` is the
  // `turn` it nests under, so the Run's settlement ends what a stop left open.
  const open = new Map<
    TaskId,
    { readonly span: Tracer.Span; readonly root: Tracer.Span | undefined }
  >();

  const close = (
    span: Tracer.Span,
    attributes: Record<string, unknown>,
    ok: boolean
  ) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.attribute(key, value);
    }
    span.end(run(Clock.currentTimeNanos), ok ? Exit.void : Exit.fail("failed"));
  };
  const end = (
    taskId: TaskId,
    attributes: Record<string, unknown>,
    ok: boolean
  ) => {
    const entry = open.get(taskId);
    if (entry === undefined) {
      return;
    }
    open.delete(taskId);
    close(entry.span, attributes, ok);
  };

  // A send's Run has no asking span, so its first span opens a `turn` root for the Run: the person's message in,
  // the last answer out, ended when pi-durable settles the Run. A model error is retried inside the same Run, so
  // only the settlement knows whether it failed. The entry outlives its Run, for `lastTurn`, until the next one.
  const runs = new Map<
    ConversationId,
    {
      readonly key: SubmissionId;
      readonly span: Tracer.Span;
      readonly attributes: Promise<Record<string, unknown>>;
    }
  >();
  const settle = async (key: SubmissionId, root: Tracer.Span) => {
    let settlement: SettledSubmissionRecord | undefined;
    try {
      settlement = await options.traceHooks?.settled?.(key);
    } catch {
      // The harness closed first; the Run's spans are lost with it.
      return;
    }
    const { attributes, ok } = runEnd(settlement);
    // A stopped request or tool call never reached its after-hook.
    for (const [taskId, entry] of open) {
      if (entry.root === root) {
        open.delete(taskId);
        close(entry.span, attributes, ok);
      }
    }
    close(root, attributes, ok);
  };
  const describe = async (
    conversationId: ConversationId,
    context: ChordContext
  ) => {
    try {
      return await options.traceHooks?.describe?.(conversationId, context);
    } catch {
      // An undescribed Run still traces; it only lacks its tags.
    }
  };
  // A Run under an asking span or a subagent's `task` call: described once per parent span.
  const described = new WeakMap<
    Tracer.AnySpan,
    Promise<Record<string, unknown>>
  >();
  // The Run a span belongs to, opening its root when it is the Run's first span. Under `ask` or a `task` call the
  // parent span roots the trace instead, and the Run only adds its description.
  const runOf = async (
    api: HookApi,
    context: ChordContext,
    input?: string
  ): Promise<
    | {
        readonly span?: Tracer.Span;
        readonly attributes: Record<string, unknown>;
      }
    | undefined
  > => {
    const parent = parents.get(api.conversationId);
    if (parent !== undefined) {
      let attributes = described.get(parent);
      if (attributes === undefined) {
        attributes = (async () =>
          runAttributes(await describe(api.conversationId, context)))();
        described.set(parent, attributes);
      }
      return { attributes: await attributes };
    }
    const runKey = await runKeyOf(api, context);
    if (runKey === undefined) {
      return;
    }
    const current = runs.get(api.conversationId);
    if (current !== undefined && current.key === runKey) {
      return { span: current.span, attributes: await current.attributes };
    }
    const span = run(
      Effect.makeSpan("turn", {
        attributes: {
          "langfuse.observation.type": "agent",
          ...(input === undefined
            ? {}
            : { "langfuse.observation.input": input }),
        },
        kind: "internal",
      })
    );
    // Claimed before `describe` is awaited, so spans starting together share one root.
    const attributes = (async () => {
      const all = {
        "langfuse.session.id": sessionOf(api.conversationId),
        "langfuse.trace.name": "turn",
        ...runAttributes(await describe(api.conversationId, context)),
      };
      for (const [key, value] of Object.entries(all)) {
        span.attribute(key, value);
      }
      return all;
    })();
    runs.set(api.conversationId, { key: runKey, span, attributes });
    void settle(runKey, span);
    return { span, attributes: await attributes };
  };
  const start = (
    taskId: TaskId,
    conversationId: ConversationId,
    name: string,
    attributes: Record<string, unknown>,
    runRoot:
      | {
          readonly span?: Tracer.Span;
          readonly attributes: Record<string, unknown>;
        }
      | undefined
  ) => {
    // A request retried after recovery opens again; the abandoned attempt ends here.
    end(taskId, {}, false);
    const parent = parents.get(conversationId) ?? runRoot?.span;
    const span = run(
      Effect.makeSpan(name, {
        attributes: {
          ...runRoot?.attributes,
          ...attributes,
          "langfuse.session.id": sessionOf(conversationId),
        },
        kind: "internal",
        ...(parent === undefined ? {} : { parent }),
      })
    );
    open.set(taskId, { span, root: runRoot?.span });
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
            await runOf(api, context, lastUserText(request.messages))
          );
          // Once per generation task — the task that produced a message's run — record its trace so feedback
          // finds it. A failed write must not break the request (hooks.each reports and swallows it anyway).
          if (!recorded.has(api.taskId)) {
            recorded.add(api.taskId);
            try {
              await options.traceHooks?.record?.(
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
        // A follow-up the Run took in answers again; the turn keeps the last answer.
        onYield: (answer, api) => {
          runs
            .get(api.conversationId)
            ?.span.attribute(
              "langfuse.observation.output",
              textOf(answer.content)
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
            await runOf(api, context)
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
    lastTurn: (conversationId) => runs.get(conversationId)?.span,
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
        parents.set(conversationId, parent.span);
      }
    },
  };
};
