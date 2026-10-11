// The server's live conversations. Each one owns a Scope holding its sandbox and the fiber that tracks its status;
// ending it, sweeping it after an idle timeout, or tearing down the layer closes that scope.
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
  Stream,
} from "effect";

import { Agents } from "../agents.ts";
import type { AgentConversation, AgentError } from "../agents.ts";
import { ConversationNotFound, SandboxLimitReached } from "../errors.ts";
import type { SandboxChoice, SandboxError } from "../sandbox/sandbox.ts";

export type ConversationStatus = "running" | "idle";

export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly createdAt: number;
}

const TITLE_LENGTH = 60;

export const titleOf = (prompt: string): string => {
  const line = prompt.trim().replaceAll(/\s+/gu, " ");
  return line.length <= TITLE_LENGTH
    ? line
    : `${line.slice(0, TITLE_LENGTH - 1)}…`;
};

interface Live {
  readonly conversation: AgentConversation;
  readonly scope: Scope.Closeable;
  readonly sandbox: SandboxChoice;
  readonly title: string;
  readonly createdAt: number;
  status: ConversationStatus;
  lastActivity: number;
}

const summaryOf = (id: number, live: Live): ConversationSummary => ({
  id,
  sandbox: live.sandbox,
  ...(live.conversation.sandbox === undefined
    ? {}
    : { sandboxId: live.conversation.sandbox.id }),
  ...(live.conversation.sandbox?.vncUrl === undefined
    ? {}
    : { vncUrl: live.conversation.sandbox.vncUrl }),
  title: live.title,
  status: live.status,
  createdAt: live.createdAt,
});

const statusAfter = (
  status: ConversationStatus,
  event: AgentEvent
): ConversationStatus => {
  switch (event.type) {
    case "snapshot": {
      return event.run === undefined ? "idle" : "running";
    }
    case "run_start": {
      return "running";
    }
    case "run_end": {
      return "idle";
    }
    default: {
      return status;
    }
  }
};

export class Conversations extends Context.Service<
  Conversations,
  {
    /** Start a conversation in a new sandbox and send its first prompt. */
    create(input: {
      readonly sandbox: SandboxChoice;
      readonly prompt: string;
    }): Effect.Effect<
      ConversationSummary,
      AgentError | SandboxError | SandboxLimitReached
    >;
    readonly list: Effect.Effect<readonly ConversationSummary[]>;
    send(
      id: number,
      prompt: string
    ): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** Events of any conversation the harness knows, including a subagent's. */
    events(
      id: number
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** End a conversation and remove its sandbox. */
    end(id: number): Effect.Effect<void, ConversationNotFound>;
  }
>()("effect-pi/Conversations") {
  static readonly layer = (options: {
    readonly maxSandboxes: number;
    readonly idleTimeoutMs: number;
    readonly sweepEveryMs: number;
  }) =>
    Layer.effect(
      Conversations,
      Effect.gen(function* () {
        const agents = yield* Agents;
        const live = new Map<number, Live>();
        // Sandboxes being created count against the cap, so concurrent creates cannot overshoot it.
        let creating = 0;

        const close = (id: number) =>
          Effect.suspend(() => {
            const entry = live.get(id);
            if (entry === undefined) {
              return Effect.void;
            }
            live.delete(id);
            return Scope.close(entry.scope, Exit.void);
          });

        const layerScope = yield* Scope.Scope;

        const reserveSandbox = (sandbox: SandboxChoice) =>
          Effect.suspend(() => {
            if (sandbox === "none") {
              return Effect.succeed(false);
            }
            const used = [...live.values()].filter(
              (entry) => entry.sandbox !== "none"
            ).length;
            if (used + creating >= options.maxSandboxes) {
              return Effect.fail(
                new SandboxLimitReached({ limit: options.maxSandboxes })
              );
            }
            creating += 1;
            return Effect.succeed(true);
          });

        const create = Effect.fn("Conversations.create")(function* (input: {
          readonly sandbox: SandboxChoice;
          readonly prompt: string;
        }) {
          // Reserve, start and register cannot be interrupted between steps, or a sandbox would leak; only
          // `start` itself may be interrupted, and then its scope and reservation are released here.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const reserved = yield* reserveSandbox(input.sandbox);
              const release = Effect.sync(() => {
                if (reserved) {
                  creating -= 1;
                }
              });
              const now = yield* Clock.currentTimeMillis;
              // Forked from the layer's scope, so tearing the layer down closes it even mid-create.
              const scope = yield* Scope.fork(layerScope);
              const started = yield* Effect.exit(
                restore(
                  agents
                    .start({ sandbox: input.sandbox })
                    .pipe(Scope.provide(scope))
                )
              );
              if (Exit.isFailure(started)) {
                yield* Scope.close(scope, Exit.void);
                yield* release;
                return yield* Effect.failCause(started.cause);
              }
              const conversation = started.value;
              const created: Live = {
                conversation,
                scope,
                sandbox: input.sandbox,
                title: titleOf(input.prompt),
                createdAt: now,
                status: "idle",
                lastActivity: now,
              };
              live.set(Number(conversation.id), created);
              yield* release;
              const id = Number(conversation.id);
              // A failure from here on must not leave the conversation, and its sandbox, registered.
              return yield* restore(
                Effect.gen(function* () {
                  // The conversation was just started, so it is always found.
                  const events = yield* agents
                    .events(conversation.id)
                    .pipe(Effect.orDie);
                  yield* events.pipe(
                    Stream.runForEach((event) =>
                      Effect.gen(function* () {
                        const time = yield* Clock.currentTimeMillis;
                        created.status = statusAfter(created.status, event);
                        created.lastActivity = time;
                      })
                    ),
                    Effect.ignore,
                    Effect.forkIn(created.scope)
                  );
                  yield* conversation.send(input.prompt);
                  return summaryOf(id, created);
                })
              ).pipe(Effect.onError(() => close(id)));
            })
          );
        });

        const find = (id: number) =>
          Effect.suspend(() => {
            const entry = live.get(id);
            return entry === undefined
              ? Effect.fail(new ConversationNotFound({ id }))
              : Effect.succeed(entry);
          });

        const sweep = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const idle = [...live.entries()].flatMap(([id, entry]) =>
            entry.status === "idle" &&
            now - entry.lastActivity >= options.idleTimeoutMs
              ? [id]
              : []
          );
          yield* Effect.forEach(idle, close, { discard: true });
        });
        yield* sweep.pipe(
          Effect.repeat(Schedule.spaced(options.sweepEveryMs)),
          Effect.forkScoped
        );

        return Conversations.of({
          create,
          list: Effect.sync(() =>
            [...live.entries()].map(([id, entry]) => summaryOf(id, entry))
          ),
          send: (id, prompt) =>
            find(id).pipe(
              Effect.flatMap((entry) => entry.conversation.send(prompt))
            ),
          events: (id) => agents.events(id as ConversationId),
          end: (id) => find(id).pipe(Effect.flatMap(() => close(id))),
        });
      })
    );
}
