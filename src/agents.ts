// An Effect service over a pi-durable harness. Each conversation is started with the sandbox the user picks
// (none, shell or desktop); its agent can spawn subagents, which share that sandbox.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  Conversation,
  ConversationId,
  EntryId,
  Extension,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import type { Cause, Scope } from "effect";

import { ConversationNotFound } from "./errors.ts";
import { SandboxDoc, SandboxError, Sandboxes } from "./sandbox/sandbox.ts";
import type { SandboxChoice, SandboxInfo } from "./sandbox/sandbox.ts";
import type { SaveScreenshot } from "./screenshots.ts";
import { installSkills, skillsExtension } from "./skills.ts";
import type { Skill } from "./skills.ts";
import { Calculator } from "./tools/calculator.ts";
import { desktopExtension } from "./tools/desktop.ts";
import { makeAgentTracing } from "./tracing.ts";
import type { AgentTracing } from "./tracing.ts";

const context = BACKGROUND_CONTEXT;

// ─── pi-durable: a tool that spawns a subagent ──────────────────────────────

const answerText = async (
  conversation: Pick<Conversation, "commit">,
  answer: EntryId
): Promise<string> => {
  const entry = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, answer),
    context
  );
  const message = entry?.model?.[0] as AssistantMessage;
  return message.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
};

export const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description:
        "Delegate a self-contained task to a subagent and get its answer back.",
      parameters: Type.Object({
        task: Type.String({ description: "What the subagent should do" }),
      }),
      replay: "safe",
      execute: async (args, api, callContext) => {
        // The child conversation is owned by this tool call: aborting the call aborts the child.
        const child = await api.commit(async (tx) => {
          const owned = await tx.scanConversations(
            { ownerTaskId: api.taskId },
            1
          );
          const [existing] = owned.items;
          if (existing !== undefined) {
            return existing.id;
          }
          const created = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          // The child cannot spawn subagents of its own.
          await configure(tx, created.id, {
            extensions: { remove: [Subagent] },
          });
          return created.id;
        }, callContext);
        // Lets a UI find and watch the child conversation while it works.
        await api.details({ conversationId: child }, callContext);
        const handle = await api.conversation(child, callContext);
        if (handle === undefined) {
          throw new Error(`Subagent conversation ${child} not found`);
        }
        const request = {
          type: "input",
          content: args.task,
          requestId: `subagent:${api.taskId}`,
        } as const;
        const submission = await handle.submit(request, callContext);
        const settled = await submission.wait(callContext);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer);
        return { content: [{ type: "text", text }] };
      },
    }),
  ],
});

// ─── Effect: the agent harness as a service ─────────────────────────────────

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  cause: Schema.Defect(),
}) {}

export interface AgentModel {
  readonly provider: string;
  readonly modelId: string;
}

/** The extensions a conversation runs with, by the sandbox the user picked. */
export const extensionsFor = (
  choice: SandboxChoice,
  desktop: Extension = desktopExtension()
): Extension[] => {
  switch (choice) {
    case "none": {
      return [Subagent, Calculator];
    }
    case "shell": {
      return [Subagent, Calculator, CodingTools];
    }
    case "desktop": {
      return [Subagent, Calculator, CodingTools, desktop];
    }
    default: {
      throw new TypeError(`Unknown sandbox choice: ${choice satisfies never}`);
    }
  }
};

const askIn = (conversation: Conversation, tracing: AgentTracing) =>
  Effect.fn("AgentConversation.ask")(function* (prompt: string) {
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.type": "agent",
      "langfuse.observation.input": prompt,
      "langfuse.session.id": String(conversation.id),
    });
    const answer = yield* tracing.traced(
      conversation.id,
      Effect.tryPromise({
        try: async () => {
          const submission = await conversation.submit(
            { type: "input", content: prompt },
            context
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(`Run failed: ${settled.status}`);
          }
          return answerText(conversation, settled.answer);
        },
        catch: (cause) => new AgentError({ cause }),
      })
    );
    yield* Effect.annotateCurrentSpan("langfuse.observation.output", answer);
    return answer;
  });

const sendIn = (conversation: Conversation, tracing: AgentTracing) =>
  Effect.fn("AgentConversation.send")(function* (prompt: string) {
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.type": "agent",
      "langfuse.observation.input": prompt,
      "langfuse.session.id": String(conversation.id),
    });
    // Admitted without waiting: a busy conversation queues it as a follow-up, and the answer arrives as events.
    yield* tracing.traced(
      conversation.id,
      Effect.tryPromise({
        try: () =>
          conversation.submit(
            { type: "input", content: prompt, whenBusy: "followUp" },
            context
          ),
        catch: (cause) => new AgentError({ cause }),
      })
    );
  });

export interface AgentConversation {
  readonly id: ConversationId;
  /** The conversation's sandbox; `undefined` when started with `sandbox: "none"`. */
  readonly sandbox: SandboxInfo | undefined;
  ask(prompt: string): Effect.Effect<string, AgentError>;
  /** Send a prompt without waiting for the answer; it is queued as a follow-up while the agent runs. */
  send(prompt: string): Effect.Effect<void, AgentError>;
}

export class Agents extends Context.Service<
  Agents,
  {
    /**
     * Start a conversation, creating its sandbox first. The sandbox is removed when the scope closes, so wrap a
     * conversation's lifetime in `Effect.scoped`.
     */
    start(options: {
      readonly sandbox: SandboxChoice;
    }): Effect.Effect<
      AgentConversation,
      AgentError | SandboxError,
      Scope.Scope
    >;
    /**
     * Watch a conversation, including a subagent's: a `snapshot` first, then the events of every later commit.
     * The watch starts when this effect completes, so the stream is single-use and must be run: finishing or
     * interrupting it stops the watch, and a stream that is never run keeps it until the harness closes.
     */
    events(
      id: ConversationId
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
  }
>()("effect-pi/Agents") {
  static readonly layer = (options: {
    readonly models: MutableModels;
    readonly model: AgentModel;
    /** Keep every desktop screenshot on the host as well; see `saveScreenshotsTo`. */
    readonly saveScreenshot?: SaveScreenshot;
    /** Skills every conversation can load (see `src/skills.ts`); copied into each sandbox. */
    readonly skills?: readonly Skill[];
  }) =>
    Layer.effect(
      Agents,
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes;
        const registry = createRegistry();
        // Spans for model requests and tool calls use the tracer this layer is built with.
        const tracing = makeAgentTracing(yield* Effect.context<never>());
        registry.install(tracing.extension);
        const skills = options.skills ?? [];
        const skillExtensions =
          skills.length === 0 ? [] : [skillsExtension(skills)];
        for (const extension of skillExtensions) {
          registry.install(extension);
        }
        const desktop = desktopExtension(
          options.saveScreenshot === undefined
            ? {}
            : { saveScreenshot: options.saveScreenshot }
        );
        for (const extension of extensionsFor("desktop", desktop)) {
          registry.install(extension);
        }

        // The harness is opened when the layer is built and closed when it is torn down.
        const harness = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              Harness.open(
                new MemoryStorage(),
                {
                  models: options.models,
                  registry,
                  // Every tool call runs in the sandbox its conversation recorded; without one there is no
                  // environment, and the file, shell and desktop tools fail with an error result.
                  env: async ({ conversationId, read }, envContext) => {
                    const doc = await read.snapshot(
                      SandboxDoc,
                      conversationId,
                      envContext
                    );
                    return doc?.sandbox === undefined
                      ? undefined
                      : sandboxes.env(doc.sandbox);
                  },
                  // A subagent's conversation works in its owner's sandbox.
                  conversationCreated: async (tx, conversation) => {
                    if (conversation.owner === undefined) {
                      return;
                    }
                    tracing.childConversation(
                      conversation.id,
                      conversation.owner
                    );
                    const owner = await tx.doc(
                      SandboxDoc,
                      conversation.owner.conversationId
                    );
                    if (owner.sandbox !== undefined) {
                      const child = await tx.doc(SandboxDoc, conversation.id);
                      child.sandbox = owner.sandbox;
                    }
                  },
                },
                context
              ),
            catch: (cause) => new AgentError({ cause }),
          }),
          (opened) => Effect.promise(() => opened.close(context))
        );

        const start = Effect.fn("Agents.start")(function* (startOptions: {
          readonly sandbox: SandboxChoice;
        }) {
          const choice = startOptions.sandbox;
          const sandbox =
            choice === "none"
              ? undefined
              : yield* Effect.acquireRelease(
                  sandboxes.create(
                    choice,
                    `effect-pi-${choice}-${crypto.randomUUID().slice(0, 8)}`
                  ),
                  (created) => Effect.ignore(sandboxes.remove(created))
                );
          if (sandbox !== undefined && skills.length > 0) {
            yield* Effect.tryPromise({
              try: () => installSkills(sandboxes.env(sandbox), skills, context),
              catch: (cause) =>
                new SandboxError({
                  message: `Could not copy skills into ${sandbox.id}`,
                  cause,
                }),
            });
          }
          const conversation = yield* Effect.tryPromise({
            try: () =>
              harness.createConversation(
                {
                  ownership: { kind: "ownerless" },
                  agent: {
                    model: { ...options.model },
                    extensions: [
                      ...extensionsFor(choice, desktop),
                      ...skillExtensions,
                      tracing.extension,
                    ],
                  },
                  // Recorded in the creating commit, so no tool call can run before the sandbox is known.
                  init: async (tx, id) => {
                    if (sandbox !== undefined) {
                      const doc = await tx.doc(SandboxDoc, id);
                      doc.sandbox = sandbox;
                    }
                  },
                },
                context
              ),
            catch: (cause) => new AgentError({ cause }),
          });
          return {
            id: conversation.id,
            sandbox,
            ask: askIn(conversation, tracing),
            send: sendIn(conversation, tracing),
          } satisfies AgentConversation;
        });

        const events = Effect.fn("Agents.events")(function* (
          id: ConversationId
        ) {
          // Only an existence check; the watch below reads the conversation itself.
          const handle = yield* Effect.tryPromise({
            try: () => harness.conversation(id, context),
            catch: (cause) => new AgentError({ cause }),
          });
          if (handle === undefined) {
            return yield* new ConversationNotFound({ id: Number(id) });
          }
          // Attached now, not when the stream is run: events committed after this call are never missed. The attach
          // and wiring are uninterruptible, so an interrupt can never leave a watch without an owner; from then on
          // the stream's finalizer stops it.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
              const watch = yield* Effect.tryPromise({
                try: () => watchEvents(harness, id, context),
                catch: (cause) => new AgentError({ cause }),
              });
              Queue.offerUnsafe(queue, watch.snapshot);
              watch.start((batch) => {
                Queue.offerAllUnsafe(queue, batch);
                return Promise.resolve();
              });
              void (async () => {
                await watch.closed;
                Queue.endUnsafe(queue);
              })();
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Effect.promise(() => watch.stop()))
              );
            })
          );
        });

        return Agents.of({ start, events });
      })
    );
}
