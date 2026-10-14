// The server's Conversations: which have Seats (see GLOSSARY.md), and when that changes. A Seat owns a Scope holding
// its Capacity claim, its Sandbox and the fiber that tracks whether a Run is going. Pause closes that scope; the
// Conversation and its Workspace's files stay, and `send` or `resume` gives it a new Seat. Every Conversation is
// paused after a restart.
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

import { Agents } from "../agents/agents.ts";
import type { AgentError, ConversationAgent, Seat } from "../agents/agents.ts";
import type { ApprovalChoice } from "../approvals.ts";
import { Capacity } from "../capacity.ts";
import type { Claim, Usage } from "../capacity.ts";
import type { StoredConversation } from "../conversation-meta.ts";
import { ApprovalNotFound, ConversationArchived } from "../errors.ts";
import type {
  CapacityExhausted,
  ConversationNotFound,
  InvalidUpgrade,
  SkillNotFound,
} from "../errors.ts";
import type {
  SandboxChoice,
  SandboxError,
  SandboxKind,
} from "../sandbox/sandbox.ts";

export type ConversationStatus = "running" | "idle" | "paused" | "archived";

export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  /** True while a Pause waits for the current Run to end. */
  readonly pausing: boolean;
  /** Calls waiting for an approval decision; only a Seat has any. */
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

/** A Conversation with a Seat. */
interface Live {
  readonly seat: Seat;
  readonly scope: Scope.Closeable;
  /** Whether a Run is going, as last read; `refresh` reads it again. */
  running: boolean;
  /** Set by Pause during a Run: the Seat closes once the Run ends, unless a `send` comes first. */
  pausing: boolean;
  lastActivity: number;
  /** Held by sends and by `close`, so no send is admitted after the scope starts closing. */
  readonly lock: Semaphore.Semaphore;
  /** Serializes `refresh`. */
  readonly reading: Semaphore.Semaphore;
}

const asId = (id: number) => id as ConversationId;

const summaryOf = (
  stored: StoredConversation,
  live: Live | undefined,
  pendingApprovals: number
): ConversationSummary => {
  const sandbox = live?.seat.sandbox;
  let status: ConversationStatus = live?.running ? "running" : "idle";
  if (live === undefined) {
    status = stored.meta.archivedAt === undefined ? "paused" : "archived";
  }
  return {
    id: Number(stored.id),
    sandbox: stored.level,
    ...(sandbox === undefined ? {} : { sandboxId: sandbox.id }),
    ...(sandbox?.vncUrl === undefined ? {} : { vncUrl: sandbox.vncUrl }),
    title: stored.meta.title,
    status,
    pausing: live?.pausing ?? false,
    pendingApprovals,
    createdAt: stored.meta.createdAt,
  };
};

type SeatError =
  | AgentError
  | SandboxError
  | CapacityExhausted
  | ConversationNotFound
  | ConversationArchived;

export class Conversations extends Context.Service<
  Conversations,
  {
    /** Record a Conversation, give it a Seat and send its first prompt. */
    create(input: {
      readonly sandbox: SandboxChoice;
      readonly prompt: string;
      readonly approvals?: "ask" | "auto" | undefined;
    }): Effect.Effect<ConversationSummary, SeatError | SkillNotFound>;
    readonly list: Effect.Effect<readonly ConversationSummary[], AgentError>;
    /** Send a prompt, resuming a paused Conversation first; a pending Pause is cancelled. */
    send(
      id: number,
      prompt: string
    ): Effect.Effect<void, SeatError | SkillNotFound>;
    /** Give a paused Conversation a Seat; for one that has a Seat, cancel a Pause waiting for its Run. */
    resume(id: number): Effect.Effect<ConversationSummary, SeatError>;
    /** Free a Conversation's Seat: at once when idle, otherwise once the current Run ends. */
    pause(id: number): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** Abort the current Run; the Seat stays, unless a Pause was waiting for the Run to end. */
    stop(id: number): Effect.Effect<void, AgentError | ConversationNotFound>;
    /**
     * Raise a Conversation's Level. With a Seat its Sandbox is replaced now, if there is room; without one its next
     * Seat gets it.
     */
    upgrade(
      id: number,
      level: SandboxKind
    ): Effect.Effect<ConversationSummary, SeatError | InvalidUpgrade>;
    /** Withdraw an Upgrade waiting for room (the agent's); true when one was waiting. */
    cancelWait(id: number): Effect.Effect<boolean>;
    /** Stop and pause a Conversation, then archive it, deleting its Workspace's files. */
    archive(
      id: number
    ): Effect.Effect<void, AgentError | SandboxError | ConversationNotFound>;
    unarchive(
      id: number
    ): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** What a Conversation runs with now. */
    agent(
      id: number
    ): Effect.Effect<ConversationAgent, AgentError | ConversationNotFound>;
    /** Events of any Conversation, with a Seat or not. */
    events(
      id: number
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** Decide a call waiting for approval; only a Seat has any, so without one every key is unknown. */
    decide(
      id: number,
      key: string,
      decision: ApprovalChoice
    ): Effect.Effect<
      void,
      AgentError | ConversationNotFound | ApprovalNotFound
    >;
    /** Each resource's limit and holders, for choosing a Seat to free. */
    readonly capacity: Effect.Effect<readonly Usage[]>;
  }
>()("effect-pi/Conversations") {
  static readonly layer = (options: {
    readonly idleTimeoutMs: number;
    readonly sweepEveryMs: number;
  }) =>
    Layer.effect(
      Conversations,
      Effect.gen(function* () {
        const agents = yield* Agents;
        const capacity = yield* Capacity;
        const live = new Map<number, Live>();
        const layerScope = yield* Scope.Scope;

        // End a Seat: its scope closes, which aborts the conversation, removes its Sandbox and releases its claim.
        const close = (id: number) =>
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
              return Scope.close(entry.scope, Exit.void);
            }).pipe(entry.lock.withPermit);
          });

        // Read whether a Run is going. Reads are serialized and each reads the latest commit, so the last one to
        // finish is never older than any change notified before it; a later change notifies again.
        const refresh = (entry: Live) =>
          entry.seat.running.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                entry.running = value;
              })
            ),
            Effect.orDie,
            entry.reading.withPermit
          );

        // Submit to a Seat unless `close` got to it first; `false` means it has no Seat any more.
        const sendLive = (id: number, entry: Live, prompt: string) =>
          Effect.suspend(() => {
            if (live.get(id) !== entry) {
              return Effect.succeed(false);
            }
            entry.pausing = false;
            return entry.seat.send(prompt).pipe(
              // A submit starts a Run in the commit that admits it, or queues behind the one going.
              Effect.andThen(refresh(entry)),
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => {
                entry.lastActivity = now;
                return true;
              })
            );
          }).pipe(entry.lock.withPermit);

        // Register a Seat and track whether a Run is going; a Pause waiting for the Run closes it when it ends.
        const register = Effect.fnUntraced(function* (id: number, entry: Live) {
          live.set(id, entry);
          const changes = yield* entry.seat.changes.pipe(Effect.orDie);
          yield* changes.pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                entry.lastActivity = yield* Clock.currentTimeMillis;
                const running = yield* refresh(entry);
                if (!running && entry.pausing) {
                  // Forked into the layer's scope: closing the Seat's own scope interrupts this fiber.
                  yield* close(id).pipe(Effect.forkIn(layerScope));
                }
              })
            ),
            Effect.ignore,
            Effect.forkIn(entry.scope)
          );
        });

        // Claim, open and register cannot be interrupted between steps, or a Sandbox would leak; only the claims
        // and `open` may be interrupted, and then the scope, with the claims and the Sandbox, is closed here.
        // A Seat claims its `seat` here; `preclaim` also claims a Level's resource, for `open` to use.
        const seatIn = <E>(
          preclaim: SandboxChoice,
          acquire: (claimed: {
            readonly assign: (id: number) => Effect.Effect<void>;
            readonly levelClaim: Claim | undefined;
          }) => Effect.Effect<
            { readonly id: number; readonly seat: Seat },
            E,
            Scope.Scope
          >
        ) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              // Forked from the layer's scope, so tearing the layer down closes it even mid-open.
              const scope = yield* Scope.fork(layerScope);
              const opened = yield* Effect.exit(
                restore(
                  Effect.gen(function* () {
                    const seatClaim = yield* capacity.claim(["seat"]);
                    const levelClaim =
                      preclaim === "none"
                        ? undefined
                        : yield* capacity.claim([preclaim]);
                    return yield* acquire({
                      assign: (id) =>
                        seatClaim
                          .assign(id)
                          .pipe(
                            Effect.andThen(
                              levelClaim?.assign(id) ?? Effect.void
                            )
                          ),
                      levelClaim,
                    });
                  }).pipe(
                    // Only a waiting claim can be cancelled, and none of these waits.
                    Effect.catchTag("ClaimCancelled", Effect.die),
                    Scope.provide(scope)
                  )
                )
              );
              if (Exit.isFailure(opened)) {
                yield* Scope.close(scope, Exit.void);
                return yield* Effect.failCause(opened.cause);
              }
              const { id, seat } = opened.value;
              const entry: Live = {
                seat,
                scope,
                running: false,
                pausing: false,
                lastActivity: yield* Clock.currentTimeMillis,
                lock: yield* Semaphore.make(1),
                reading: yield* Semaphore.make(1),
              };
              yield* register(id, entry);
              return { id, entry };
            })
          );

        const create = Effect.fn("Conversations.create")(function* (input: {
          readonly sandbox: SandboxChoice;
          readonly prompt: string;
          readonly approvals?: "ask" | "auto" | undefined;
        }) {
          const { id, entry } = yield* seatIn(input.sandbox, (claimed) =>
            Effect.gen(function* () {
              // Claimed first, so a create at a limit records nothing. The title is the prompt as typed.
              const created = yield* agents.create({
                prompt: input.prompt,
                title: titleOf(input.prompt),
                level: input.sandbox,
                createdAt: yield* Clock.currentTimeMillis,
                approvals: input.approvals,
              });
              yield* claimed.assign(Number(created));
              return {
                id: Number(created),
                seat: yield* agents.open(
                  created,
                  claimed.levelClaim === undefined
                    ? {}
                    : { levelClaim: claimed.levelClaim }
                ),
              };
            })
          );
          // A Seat whose first prompt cannot be sent is paused: the Conversation stays, resumable.
          yield* sendLive(id, entry, input.prompt).pipe(
            Effect.onError(() => close(id))
          );
          const stored = yield* agents.get(asId(id));
          return summaryOf(stored, entry, 0);
        });

        // Resumes run one at a time. Two sends can race to resume the same Conversation, and a second Seat
        // could not simply be discarded: closing its scope aborts the conversation, including the Run the
        // first send just started.
        const resuming = yield* Semaphore.make(1);

        const seatOf = (id: number) =>
          Effect.suspend(() => {
            const existing = live.get(id);
            if (existing !== undefined) {
              return Effect.succeed(existing);
            }
            return Effect.gen(function* () {
              const stored = yield* agents.get(asId(id));
              if (stored.meta.archivedAt !== undefined) {
                return yield* new ConversationArchived({ id });
              }
              // `open` claims the Level's resource itself.
              const { entry } = yield* seatIn("none", (claimed) =>
                Effect.gen(function* () {
                  yield* claimed.assign(id);
                  return { id, seat: yield* agents.open(asId(id)) };
                })
              );
              return entry;
            });
          }).pipe(resuming.withPermit);

        const send = Effect.fn("Conversations.send")(function* (
          id: number,
          prompt: string
        ) {
          // A Seat that closes while this send waits for it is resumed again: the send is the newer intent.
          for (let tries = 0; tries < 3; tries += 1) {
            const entry = yield* seatOf(id);
            if (yield* sendLive(id, entry, prompt)) {
              return;
            }
          }
          return yield* Effect.die(
            new Error(`Conversation ${id} kept losing its Seat`)
          );
        });

        const resume = Effect.fn("Conversations.resume")(function* (
          id: number
        ) {
          const entry = yield* seatOf(id);
          // Resuming a Seat whose Pause waits for the Run cancels that Pause.
          entry.pausing = false;
          const stored = yield* agents.get(asId(id));
          return summaryOf(stored, entry, 0);
        });

        const pause = Effect.fn("Conversations.pause")(function* (id: number) {
          const entry = live.get(id);
          if (entry === undefined) {
            yield* agents.get(asId(id));
            return;
          }
          entry.pausing = true;
          // Read after setting `pausing`, so a Run ending in between is seen here or by the tracking fiber.
          if (!entry.running) {
            yield* close(id);
          }
        });

        const stop = Effect.fn("Conversations.stop")(function* (id: number) {
          const entry = live.get(id);
          if (entry === undefined) {
            yield* agents.get(asId(id));
            return;
          }
          yield* entry.seat.stop;
          // `stop` returns once the conversation is idle; the watch may report it later.
          yield* refresh(entry);
          if (entry.pausing && !entry.running) {
            yield* close(id);
          }
        });

        const upgrade = Effect.fn("Conversations.upgrade")(function* (
          id: number,
          level: SandboxKind
        ) {
          const entry = live.get(id);
          if (entry === undefined) {
            const stored = yield* agents.get(asId(id));
            if (stored.meta.archivedAt !== undefined) {
              return yield* new ConversationArchived({ id });
            }
            yield* agents.upgrade(asId(id), level);
          } else {
            yield* entry.seat
              .upgrade(level)
              .pipe(Effect.catchTag("ClaimCancelled", Effect.die));
          }
          const stored = yield* agents.get(asId(id));
          return summaryOf(
            stored,
            live.get(id),
            entry === undefined ? 0 : yield* entry.seat.pendingApprovals
          );
        });

        const archive = Effect.fn("Conversations.archive")(function* (
          id: number
        ) {
          const entry = live.get(id);
          if (entry !== undefined) {
            yield* entry.seat.stop;
            yield* close(id);
          }
          yield* agents.archive(asId(id), yield* Clock.currentTimeMillis);
        });

        const decide = Effect.fn("Conversations.decide")(function* (
          id: number,
          key: string,
          decision: ApprovalChoice
        ) {
          const entry = live.get(id);
          if (entry === undefined) {
            yield* agents.get(asId(id));
            return yield* new ApprovalNotFound({ key });
          }
          yield* entry.seat.decide(key, decision);
        });

        const list = Effect.gen(function* () {
          const stored = yield* agents.list;
          const listed: ConversationSummary[] = [];
          for (const each of stored) {
            const entry = live.get(Number(each.id));
            const pending =
              entry === undefined ? 0 : yield* entry.seat.pendingApprovals;
            listed.push(summaryOf(each, entry, pending));
          }
          return listed.toSorted((a, b) => b.createdAt - a.createdAt);
        });

        const sweep = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const idle = [...live.entries()].flatMap(([id, entry]) =>
            !entry.running && now - entry.lastActivity >= options.idleTimeoutMs
              ? [id]
              : []
          );
          yield* Effect.forEach(idle, (id) => close(id), { discard: true });
        });
        yield* sweep.pipe(
          Effect.repeat(Schedule.spaced(options.sweepEveryMs)),
          Effect.forkScoped
        );

        return Conversations.of({
          create,
          list,
          send,
          resume,
          pause,
          stop,
          upgrade,
          cancelWait: (id) => capacity.cancel(id),
          archive,
          unarchive: (id) => agents.unarchive(asId(id)),
          events: (id) => agents.events(asId(id)),
          agent: (id) => agents.agent(asId(id)),
          decide,
          capacity: capacity.usage,
        });
      })
    );
}
