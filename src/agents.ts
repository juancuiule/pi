// An Effect service over a pi-durable harness whose root agent can spawn subagents through a tool.
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
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  EntryId,
  Extension,
} from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Schema } from "effect";

import { Calculator } from "./tools/calculator.ts";

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

export class Agents extends Context.Service<
  Agents,
  {
    ask(prompt: string): Effect.Effect<string, AgentError>;
  }
>()("effect-pi/Agents") {
  static readonly layer = (options: {
    readonly models: MutableModels;
    readonly model: AgentModel;
  }) =>
    Layer.effect(
      Agents,
      Effect.gen(function* () {
        const registry = createRegistry();
        registry.install(Subagent);
        registry.install(Calculator);

        // The harness is opened when the layer is built and closed when it is torn down.
        const harness = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              Harness.open(
                new MemoryStorage(),
                { models: options.models, registry },
                context
              ),
            catch: (cause) => new AgentError({ cause }),
          }),
          (opened) => Effect.promise(() => opened.close(context))
        );
        const root = yield* Effect.tryPromise({
          try: () =>
            harness.root(context, { agent: { model: { ...options.model } } }),
          catch: (cause) => new AgentError({ cause }),
        });

        const ask = Effect.fn("Agents.ask")((prompt: string) =>
          Effect.tryPromise({
            try: async () => {
              const submission = await root.submit(
                { type: "input", content: prompt },
                context
              );
              const settled = await submission.wait(context);
              if (settled.status !== "done" || settled.type !== "input") {
                throw new Error(`Run failed: ${settled.status}`);
              }
              return answerText(root, settled.answer);
            },
            catch: (cause) => new AgentError({ cause }),
          })
        );

        return Agents.of({ ask });
      })
    );
}
