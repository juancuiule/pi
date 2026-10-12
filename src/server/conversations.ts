// The server's conversations. Live ones own a Scope holding their sandbox and the fiber that tracks
// their status; ended, swept or restarted ones are stored metadata that stays listed. Ending,
// sweeping or tearing down the layer closes a live scope; a stored chat conversation can be resumed
// by `send`, which attaches it in a fresh scope.
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { Agents } from "../agents.ts";
import type { AgentConversation, AgentError } from "../agents.ts";
import type { ConversationMeta } from "../conversation-meta.ts";
import {
  ConversationEnded,
  ConversationNotFound,
  SandboxLimitReached,
} from "../errors.ts";
import type { ApprovalNotFound, SkillNotFound } from "../errors.ts";
import type { SandboxChoice, SandboxError } from "../sandbox/sandbox.ts";

export type ConversationStatus = "running" | "idle" | "ended";
export type EndedReason = "ended" | "sandbox_removed";

export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly endedReason?: EndedReason;
  /** Calls waiting for an approval decision; live conversations only. */
  readonly pendingApprovals: number;
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
  readonly meta: {
    readonly title: string;
    readonly sandbox: SandboxChoice;
    readonly createdAt: number;
  };
  status: ConversationStatus;
  lastActivity: number;
  /** True from registration until the first run ends: `status` is still "idle" until `run_start` is consumed. */
  firstRunPending: boolean;
  /** Held by sends and by `close`, so no send is admitted after the scope starts closing. */
  readonly lock: Semaphore.Semaphore;
}

/** A stored conversation: metadata only, no live scope. */
interface Stored {
  readonly meta: ConversationMeta;
}

const summaryOfLive = (id: number, live: Live): ConversationSummary => ({
  id,
  sandbox: live.meta.sandbox,
  ...(live.conversation.sandbox === undefined
    ? {}
    : { sandboxId: live.conversation.sandbox.id }),
  ...(live.conversation.sandbox?.vncUrl === undefined
    ? {}
    : { vncUrl: live.conversation.sandbox.vncUrl }),
  title: live.meta.title,
  status: live.status,
  pendingApprovals: 0,
  createdAt: live.meta.createdAt,
});

// Stored rules: explicitly ended wins; a conversation whose sandbox is gone can never run again;
// a chat conversation (`sandbox: "none"`) is only dormant — `send` re-attaches it.
const summaryOfStored = (id: number, stored: Stored): ConversationSummary => {
  const ended = stored.meta.endedAt !== undefined;
  const sandboxRemoved = !ended && stored.meta.sandbox !== "none";
  return {
    id,
    sandbox: stored.meta.sandbox,
    title: stored.meta.title,
    status: ended || sandboxRemoved ? "ended" : "idle",
    pendingApprovals: 0,
    ...(ended || sandboxRemoved
      ? { endedReason: ended ? "ended" : "sandbox_removed" }
      : {}),
    createdAt: stored.meta.createdAt,
  };
};

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
      readonly approvals?: "ask" | "auto";
    }): Effect.Effect<
      ConversationSummary,
      AgentError | SandboxError | SandboxLimitReached | SkillNotFound
    >;
    readonly list: Effect.Effect<readonly ConversationSummary[], AgentError>;
    /** Send to a live conversation, resume a dormant chat one, or reject an ended one. */
    send(
      id: number,
      prompt: string
    ): Effect.Effect<
      void,
      AgentError | ConversationNotFound | ConversationEnded | SkillNotFound
    >;
    /** Events of any conversation the harness knows, including a subagent's or a stored one's. */
    events(
      id: number
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** End a conversation and remove its sandbox; it stays listed as ended. */
    end(id: number): Effect.Effect<void, ConversationNotFound>;
    /** Decide a pending tool call; `id` is the top-level conversation, `key` names the call. */
    decide(
      id: number,
      key: string,
      decision: "approve" | "deny" | "always"
    ): Effect.Effect<
      void,
      AgentError | ConversationNotFound | ApprovalNotFound
    >;
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
        const stored = new Map<number, Stored>();
        // Sandboxes being created count against the cap, so concurrent creates cannot overshoot it.
        let creating = 0;

        // Every persisted conversation that is not live right now.
        for (const record of yield* agents.stored) {
          stored.set(Number(record.id), { meta: record.meta });
        }

        const layerScope = yield* Scope.Scope;

        // Move a live entry to the stored map once its scope is closed. `endedAt` marks an explicit
        // end; a swept or closed conversation keeps its meta and stays resumable (chat) or dead
        // (sandbox removed by the finalizer).
        const close = (id: number, endedAt?: number) =>
          Effect.suspend(() => {
            const entry = live.get(id);
            if (entry === undefined) {
              return Effect.void;
            }
            return Effect.suspend(() => {
              if (live.get(id) !== entry) {
                return Effect.void;
              }
              live.delete(id);
              stored.set(id, {
                meta: {
                  ...entry.meta,
                  ...(endedAt === undefined ? {} : { endedAt }),
                },
              });
              return Scope.close(entry.scope, Exit.void);
            }).pipe(entry.lock.withPermit);
          });

        // Submit to a live entry unless `close` got to it first; `false` means it is no longer live.
        const sendLive = (id: number, entry: Live, prompt: string) =>
          Effect.suspend(() =>
            live.get(id) === entry
              ? entry.conversation.send(prompt).pipe(Effect.as(true))
              : Effect.succeed(false)
          ).pipe(entry.lock.withPermit);

        // Register a live entry and start the fiber that tracks its status; the same steps `create`
        // takes after `start` and `send` takes after `attach`.
        const track = Effect.fn("Conversations.track")(function* (
          created: Live
        ) {
          // The conversation exists, so `events` always finds it.
          const events = yield* agents
            .events(created.conversation.id)
            .pipe(Effect.orDie);
          yield* events.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                const time = yield* Clock.currentTimeMillis;
                created.status = statusAfter(created.status, event);
                if (event.type === "run_end") {
                  created.firstRunPending = false;
                }
                created.lastActivity = time;
              })
            ),
            Effect.ignore,
            Effect.forkIn(created.scope)
          );
        });

        const reserveSandbox = (sandbox: SandboxChoice) =>
          Effect.suspend(() => {
            if (sandbox === "none") {
              return Effect.succeed(false);
            }
            const used = [...live.values()].filter(
              (entry) => entry.meta.sandbox !== "none"
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
          readonly approvals?: "ask" | "auto";
        }) {
          // Expanded first, so an unknown skill reserves and creates nothing. The title is the prompt as typed.
          const prompt = yield* agents.expandSkill(input.prompt);
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
              const title = titleOf(input.prompt);
              // Forked from the layer's scope, so tearing the layer down closes it even mid-create.
              const scope = yield* Scope.fork(layerScope);
              const started = yield* Effect.exit(
                restore(
                  agents
                    .start({
                      sandbox: input.sandbox,
                      title,
                      createdAt: now,
                      ...(input.approvals === undefined
                        ? {}
                        : { approvals: input.approvals }),
                    })
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
                meta: {
                  title,
                  sandbox: input.sandbox,
                  createdAt: now,
                },
                status: "idle",
                lastActivity: now,
                firstRunPending: true,
                lock: yield* Semaphore.make(1),
              };
              const id = Number(conversation.id);
              live.set(id, created);
              stored.delete(id);
              yield* release;
              // A failure from here on must not leave the conversation, and its sandbox, registered. The
              // conversation is already persisted and cannot be deleted, so it is marked ended: it stays
              // listed as ended instead of as a resumable chat that never got its first prompt.
              return yield* restore(
                Effect.gen(function* () {
                  yield* track(created);
                  yield* sendLive(id, created, prompt);
                  return summaryOfLive(id, created);
                })
              ).pipe(
                Effect.onError(() =>
                  Effect.gen(function* () {
                    const endedAt = yield* Clock.currentTimeMillis;
                    yield* close(id, endedAt);
                    yield* Effect.ignore(
                      agents.markEnded(id as ConversationId, endedAt)
                    );
                  })
                )
              );
            })
          );
        });

        // Resumes run one at a time. Two sends can race to resume the same dormant conversation, and
        // a second attach could not simply be discarded: closing its scope aborts the conversation,
        // including the run the first send just started.
        const resuming = yield* Semaphore.make(1);

        // A stored chat conversation comes back live: attach it in a scope forked from the layer's.
        const resume = Effect.fn("Conversations.resume")(function* (
          id: number,
          entry: Stored
        ) {
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const existing = live.get(id);
              if (existing !== undefined) {
                return existing;
              }
              const scope = yield* Scope.fork(layerScope);
              const attached = yield* Effect.exit(
                restore(
                  agents.attach(id as ConversationId).pipe(Scope.provide(scope))
                )
              );
              if (Exit.isFailure(attached)) {
                yield* Scope.close(scope, Exit.void);
                return yield* Effect.failCause(attached.cause);
              }
              const now = yield* Clock.currentTimeMillis;
              const revived: Live = {
                conversation: attached.value,
                scope,
                meta: {
                  title: entry.meta.title,
                  sandbox: entry.meta.sandbox,
                  createdAt: entry.meta.createdAt,
                },
                status: "idle",
                lastActivity: now,
                firstRunPending: false,
                lock: yield* Semaphore.make(1),
              };
              live.set(id, revived);
              stored.delete(id);
              yield* track(revived);
              return revived;
            })
          ).pipe(resuming.withPermit);
        });

        const send = Effect.fn("Conversations.send")(function* (
          id: number,
          prompt: string
        ) {
          const expanded = yield* agents.expandSkill(prompt);
          const liveEntry = live.get(id);
          // A live entry that closed while this send waited falls through to the stored rules below.
          if (
            liveEntry !== undefined &&
            (yield* sendLive(id, liveEntry, expanded))
          ) {
            return;
          }
          const storedEntry = stored.get(id);
          if (storedEntry === undefined) {
            return yield* new ConversationNotFound({ id });
          }
          if (storedEntry.meta.endedAt !== undefined) {
            return yield* new ConversationEnded({ id, reason: "ended" });
          }
          if (storedEntry.meta.sandbox !== "none") {
            return yield* new ConversationEnded({
              id,
              reason: "sandbox_removed",
            });
          }
          const revived = yield* resume(id, storedEntry);
          if (yield* sendLive(id, revived, expanded)) {
            return;
          }
          // Only End closes a just-resumed conversation (the sweep waits for it to go idle).
          return yield* new ConversationEnded({ id, reason: "ended" });
        });

        const end = Effect.fn("Conversations.end")(function* (id: number) {
          const now = yield* Clock.currentTimeMillis;
          if (live.has(id)) {
            yield* close(id, now);
            // The metadata write is best-effort: a failure here is a defect, not a 500 to report.
            yield* agents
              .markEnded(id as ConversationId, now)
              .pipe(Effect.orDie);
            return;
          }
          const storedEntry = stored.get(id);
          if (storedEntry === undefined) {
            return yield* new ConversationNotFound({ id });
          }
          if (storedEntry.meta.endedAt === undefined) {
            yield* agents
              .markEnded(id as ConversationId, now)
              .pipe(Effect.orDie);
            stored.set(id, {
              meta: { ...storedEntry.meta, endedAt: now },
            });
          }
        });

        const sweep = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const idle = [...live.entries()].flatMap(([id, entry]) =>
            entry.status === "idle" &&
            !entry.firstRunPending &&
            now - entry.lastActivity >= options.idleTimeoutMs
              ? [id]
              : []
          );
          // Swept conversations stay stored: chat ones resume on the next `send`, sandbox ones are
          // `sandbox_removed` from then on.
          yield* Effect.forEach(idle, (id) => close(id), { discard: true });
        });
        yield* sweep.pipe(
          Effect.repeat(Schedule.spaced(options.sweepEveryMs)),
          Effect.forkScoped
        );

        return Conversations.of({
          create,
          list: Effect.gen(function* () {
            const listed: ConversationSummary[] = [];
            for (const [id, entry] of live) {
              const pending = yield* agents.pendingApprovals(
                entry.conversation.id
              );
              listed.push({
                ...summaryOfLive(id, entry),
                pendingApprovals: pending,
              });
            }
            for (const [id, entry] of stored) {
              listed.push(summaryOfStored(id, entry));
            }
            return listed.toSorted((a, b) => b.createdAt - a.createdAt);
          }),
          send,
          events: (id) => agents.events(id as ConversationId),
          end,
          decide: (id, key, decision) => {
            if (!live.has(id) && !stored.has(id)) {
              return Effect.fail(new ConversationNotFound({ id }));
            }
            return agents.decide(id as ConversationId, key, decision);
          },
        });
      })
    );
}
