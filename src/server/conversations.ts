// The server's Conversations: which have Seats (see GLOSSARY.md), and when that changes. A Seat owns a Scope holding
// its Capacity claim, its Sandbox and the fiber that tracks whether a Run is going. Pause closes that scope; the
// Conversation and its Workspace's files stay, and `send` or `resume` gives it a new Seat. Every Conversation is
// paused after a restart.
import type {
  ConversationId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { Agents } from "../agents/agents.ts";
import type {
  AgentError,
  ConversationAgent,
  Seat,
  UpgradeRequest,
} from "../agents/agents.ts";
import type { SettingsChange } from "../agents/settings.ts";
import type { AnswerInput, ApprovalChoice } from "../approvals.ts";
import { Attachments } from "../attachments/attachments.ts";
import type { Attention } from "../attention.ts";
import type { UserId } from "../auth/user.ts";
import { Capacity } from "../capacity.ts";
import type { Claim, Usage } from "../capacity.ts";
import type { ConversationEvent, HistoryPage } from "../conversation-events.ts";
import type { StoredConversation } from "../conversation-meta.ts";
import {
  ApprovalNotFound,
  ConversationArchived,
  InvalidSetting,
  TraceUnavailable,
} from "../errors.ts";
import type {
  AttachmentNotFound,
  AttachmentRefused,
  CapacityExhausted,
  ConversationNotFound,
  EntryNotFound,
  InvalidUpgrade,
  SkillNotFound,
  SubmissionNotFound,
  TitleGenerationFailed,
} from "../errors.ts";
import type { LangfuseOptions } from "../langfuse.ts";
import { postScore } from "../langfuse.ts";
import type { SandboxChoice, SandboxError } from "../sandbox/sandbox.ts";
import { checkSoftware, normalize } from "../sandbox/software.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import { Search } from "../search/search.ts";
import { Workspaces } from "../workspaces/workspaces.ts";

export type ConversationStatus = "running" | "idle" | "paused" | "archived";

export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly software: readonly SoftwareId[];
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  /** True while a Pause waits for the current Run to end. */
  readonly pausing: boolean;
  /** Calls waiting for an approval decision; only a Seat has any. */
  readonly pendingApprovals: number;
  /** The last settled input ended badly — a failed run or the repeat guard's stop. */
  readonly attention?: Attention;
  readonly createdAt: number;
}

const TITLE_LENGTH = 60;

/** A title from the prompt as typed, or the attached files' names for a message of only files. */
export const titleOf = (
  prompt: string,
  files: readonly string[] = []
): string => {
  if (prompt.trim() === "" && files.length > 0) {
    return titleOf(files.join(", "));
  }
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
  /** Set when a run-end checkpoint is in flight, so every `refresh` caller does not queue another. */
  checkpointed: boolean;
  /** Held by sends and by `close`, so no send is admitted after the scope starts closing. */
  readonly lock: Semaphore.Semaphore;
  /** Serializes `refresh`. */
  readonly reading: Semaphore.Semaphore;
}

const asId = (id: number) => id as ConversationId;

const summaryOf = (
  stored: StoredConversation,
  live: Live | undefined,
  pendingApprovals: number,
  attention: Attention | undefined
): ConversationSummary => {
  const sandbox = live?.seat.sandbox;
  let status: ConversationStatus = live?.running ? "running" : "idle";
  if (live === undefined) {
    status = stored.meta.archivedAt === undefined ? "paused" : "archived";
  }
  return {
    id: Number(stored.id),
    sandbox: stored.level,
    software: stored.software,
    ...(sandbox === undefined ? {} : { sandboxId: sandbox.id }),
    ...(sandbox?.vncUrl === undefined ? {} : { vncUrl: sandbox.vncUrl }),
    title: stored.meta.title,
    status,
    pausing: live?.pausing ?? false,
    pendingApprovals,
    ...(attention === undefined ? {} : { attention }),
    createdAt: stored.meta.createdAt,
  };
};

type AttachmentError = AttachmentNotFound | AttachmentRefused;

type SeatError =
  | AgentError
  | SandboxError
  | CapacityExhausted
  | ConversationNotFound
  | ConversationArchived;

export class Conversations extends Context.Service<
  Conversations,
  {
    /**
     * Record a Conversation, give it a Seat and send its first message: the prompt and the staged uploads in
     * `attachments`, which it claims, all or none. `requestId` deduplicates the message's submission, whose record
     * comes back with the summary.
     */
    create(input: {
      /** The User it belongs to. */
      readonly owner: UserId;
      readonly sandbox: SandboxChoice;
      readonly software?: readonly SoftwareId[] | undefined;
      readonly prompt: string;
      readonly attachments?: readonly string[] | undefined;
      readonly requestId?: string | undefined;
      readonly approvals?: "ask" | "auto" | undefined;
      readonly settings?: Omit<SettingsChange, "approvals"> | undefined;
    }): Effect.Effect<
      ConversationSummary & { readonly submission: SubmissionRecord },
      SeatError | SkillNotFound | InvalidSetting | AttachmentError
    >;
    /** `owner`'s Conversations, newest first. */
    list(
      owner: UserId
    ): Effect.Effect<readonly ConversationSummary[], AgentError>;
    /**
     * Send a prompt with the Conversation's unsent uploads in `attachments`, resuming a paused Conversation first; a
     * pending Pause is cancelled. `requestId` deduplicates the submission, whose record comes back.
     */
    send(
      id: number,
      prompt: string,
      attachments?: readonly string[],
      requestId?: string
    ): Effect.Effect<
      SubmissionRecord,
      SeatError | SkillNotFound | AttachmentError
    >;
    /** The Conversation's Seat when it has one; a paused or archived Conversation has none. Never resumes. */
    seat(id: number): Effect.Effect<Seat | undefined>;
    /** Give a paused Conversation a Seat; for one that has a Seat, cancel a Pause waiting for its Run. */
    resume(id: number): Effect.Effect<ConversationSummary, SeatError>;
    /** Free a Conversation's Seat: at once when idle, otherwise once the current Run ends. */
    pause(id: number): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** Abort the current Run; the Seat stays, unless a Pause was waiting for the Run to end. */
    stop(id: number): Effect.Effect<void, AgentError | ConversationNotFound>;
    /**
     * Raise a Conversation's Level, add Software, or both. With a Seat its Sandbox is replaced now, if there is room
     * for another of its Level; without one its next Seat gets it.
     */
    upgrade(
      id: number,
      request: UpgradeRequest
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
    /** Rename a Conversation's title; marks it manual. */
    rename(
      id: number,
      title: string
    ): Effect.Effect<ConversationSummary, AgentError | ConversationNotFound>;
    /** Generate a title with the conversation's model; works paused or archived. */
    generateTitle(
      id: number
    ): Effect.Effect<
      ConversationSummary,
      AgentError | ConversationNotFound | TitleGenerationFailed
    >;
    /** What a Conversation runs with now: its settings, model and prompt sections. */
    agent(
      id: number
    ): Effect.Effect<ConversationAgent, AgentError | ConversationNotFound>;
    /** Back to what a new Conversation at its Level gets; the approval policy stays. */
    reset(
      id: number
    ): Effect.Effect<
      ConversationAgent,
      AgentError | ConversationNotFound | InvalidSetting | SandboxError
    >;
    /** Turn a Conversation's extensions, tools and skills on or off, or set its approval policy. */
    configure(
      id: number,
      change: SettingsChange
    ): Effect.Effect<
      ConversationAgent,
      AgentError | ConversationNotFound | InvalidSetting | SandboxError
    >;
    /** Events of any Conversation, with a Seat or not. */
    events(
      id: number
    ): Effect.Effect<
      Stream.Stream<ConversationEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** Entries a head marker hides from the active context, oldest first; `before` pages back from an entry id. */
    history(
      id: number,
      options?: { before?: number | undefined; limit?: number | undefined }
    ): Effect.Effect<HistoryPage, AgentError | ConversationNotFound>;
    /**
     * Withdraw a queued message's submission before a run places it; `placed` or `settled` when its run already
     * took it. Seatless — a paused Conversation's queue can be withdrawn from too.
     */
    withdraw(
      id: number,
      submission: number
    ): Effect.Effect<
      "withdrawn" | "placed" | "settled",
      AgentError | ConversationNotFound | SubmissionNotFound
    >;
    /**
     * Score an assistant entry thumbs up (`value: 1`) or down (`value: 0`) on its run's Langfuse trace.
     * Scores upsert, so scoring the same entry again replaces the earlier one. `TraceUnavailable` with
     * `disabled` when the server does not trace, `untraced` when the entry's run left no trace.
     */
    feedback(
      id: number,
      input: {
        readonly entry: number;
        readonly value: 0 | 1;
        readonly comment?: string | undefined;
      }
    ): Effect.Effect<
      void,
      AgentError | ConversationNotFound | EntryNotFound | TraceUnavailable
    >;
    /** Report an assistant entry with a required comment, as a Langfuse score on its run's trace. */
    report(
      id: number,
      input: { readonly entry: number; readonly comment: string }
    ): Effect.Effect<
      void,
      AgentError | ConversationNotFound | EntryNotFound | TraceUnavailable
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
    /** Answer an `ask_user` call, or skip it without `answers`; like `decide`, only a Seat has any. */
    answer(
      id: number,
      key: string,
      answers?: readonly AnswerInput[]
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
    /** Langfuse's project keys: feedback and report posts score the entry's run trace. Unset, they are disabled. */
    readonly langfuse?: LangfuseOptions | undefined;
  }) =>
    Layer.effect(
      Conversations,
      Effect.gen(function* () {
        const agents = yield* Agents;
        const attachments = yield* Attachments;
        const capacity = yield* Capacity;
        const workspaces = yield* Workspaces;
        const search = yield* Search;
        const live = new Map<number, Live>();
        // A Seat mid-open, before `register` lands it in `live`: its Conversation is recorded already, so it
        // reads as paused. Look-ups wait on the gate instead of opening a second Seat or writing its Workspace;
        // a first Software build can hold it for minutes.
        const opening = new Map<number, Deferred.Deferred<boolean>>();
        const layerScope = yield* Scope.Scope;

        // Wake what waits on `id`'s open. The gate leaves `opening` before it completes, so a late look-up sees
        // `live` (or nothing) rather than a spent gate.
        const settleOpening = (id: number, gate: Deferred.Deferred<boolean>) =>
          Effect.sync(() => {
            if (opening.get(id) === gate) {
              opening.delete(id);
            }
          }).pipe(Effect.andThen(Deferred.succeed(gate, true)));

        // A Conversation's Live entry, waiting out a Seat mid-open; `undefined` when it truly has none.
        const seatEntry = (id: number): Effect.Effect<Live | undefined> =>
          Effect.suspend(() => {
            const entry = live.get(id);
            if (entry !== undefined) {
              return Effect.succeed(entry);
            }
            const gate = opening.get(id);
            return gate === undefined
              ? Effect.succeed(entry)
              : Deferred.await(gate).pipe(Effect.andThen(() => seatEntry(id)));
          });

        // Every summary carries attention: the console replaces its cached summary with each
        // response, so one caller skipping it would drop the dot until the next poll. A stored
        // id cannot vanish, but the catch keeps `list` total.
        const attentionOf = (id: number) =>
          agents.attention(asId(id)).pipe(
            Effect.catchTag("ConversationNotFound", () =>
              // oxlint-disable-next-line unicorn/no-useless-undefined -- a conversation gone between list and read reports nothing
              Effect.succeed(undefined)
            )
          );

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
              Effect.gen(function* () {
                const was = entry.running;
                entry.running = value;
                if (value) {
                  entry.checkpointed = false;
                } else if (was) {
                  // A Run's entries are committed when it ends, Sandbox or none — this edge is
                  // the only signal that fires for every run, paused ones included.
                  yield* search.indexConversation(entry.seat.id).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Search indexing of conversation ${entry.seat.id} failed`,
                        cause
                      )
                    ),
                    Effect.forkIn(layerScope)
                  );
                }
                if (was && !value && !entry.pausing && !entry.checkpointed) {
                  const { sandbox, storage } = entry.seat;
                  if (sandbox !== undefined && storage !== undefined) {
                    entry.checkpointed = true;
                    // A checkpoint after each Run bounds what a crash loses; a Pause's closing save
                    // takes over instead, and the release joins this fiber through the storage lock.
                    // Any refresh can observe the transition, so the checkpoint lives here, not in
                    // the changes stream alone (a `stop` refresh could otherwise eat it).
                    yield* workspaces.save(storage, sandbox, "checkpoint").pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `Workspace checkpoint of conversation ${entry.seat.id} failed`,
                          cause
                        )
                      ),
                      Effect.forkIn(layerScope)
                    );
                  }
                }
                if (was && !value) {
                  // One answered Run earns one automatic title; the meta latch inside decides.
                  // Unlike the checkpoint it needs no Sandbox, and a Pause is no reason to skip it.
                  yield* agents.autoTitle(entry.seat.id).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Title generation of conversation ${entry.seat.id} failed`,
                        cause
                      )
                    ),
                    Effect.forkIn(layerScope)
                  );
                }
              })
            ),
            Effect.orDie,
            entry.reading.withPermit
          );

        // Submit to a Seat unless `close` got to it first; `false` means it has no Seat any more.
        const sendLive = (
          id: number,
          entry: Live,
          prompt: string,
          files: readonly string[],
          requestId?: string
        ) =>
          Effect.suspend(
            (): Effect.Effect<
              SubmissionRecord | false,
              | AgentError
              | SkillNotFound
              | AttachmentNotFound
              | AttachmentRefused
            > => {
              if (live.get(id) !== entry) {
                return Effect.succeed(false);
              }
              entry.pausing = false;
              return entry.seat.send(prompt, files, requestId).pipe(
                // A submit starts a Run in the commit that admits it, or queues behind the one going.
                Effect.andThen((submission) =>
                  refresh(entry).pipe(
                    Effect.andThen(Clock.currentTimeMillis),
                    Effect.map((now) => {
                      entry.lastActivity = now;
                      return submission;
                    })
                  )
                )
              );
            }
          ).pipe(entry.lock.withPermit);

        // Register a Seat and track whether a Run is going; a Pause waiting for the Run closes it when it ends.
        const register = Effect.fnUntraced(function* (id: number, entry: Live) {
          live.set(id, entry);
          const gate = opening.get(id);
          if (gate !== undefined) {
            yield* settleOpening(id, gate);
          }
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
                checkpointed: false,
                lastActivity: yield* Clock.currentTimeMillis,
                lock: yield* Semaphore.make(1),
                reading: yield* Semaphore.make(1),
              };
              yield* register(id, entry);
              return { id, entry };
            })
          );

        // Resumes run one at a time. Two sends can race to resume the same Conversation, and a second Seat
        // could not simply be discarded: closing its scope aborts the conversation, including the Run the
        // first send just started.
        const resuming = yield* Semaphore.make(1);

        const seatOf = (id: number): Effect.Effect<Live, SeatError> =>
          Effect.suspend(() => {
            const existing = live.get(id);
            if (existing !== undefined) {
              return Effect.succeed(existing);
            }
            const gate = opening.get(id);
            if (gate !== undefined) {
              // Its Seat is mid-open — this create's, or a resume's. Wait for it; a second open would leak the loser.
              return Deferred.await(gate).pipe(
                Effect.andThen(() => seatOf(id))
              );
            }
            // Only a real resume waits: a live Seat, or a send racing one, never queues behind another
            // Conversation's open.
            return Effect.suspend(() => {
              const arrived = live.get(id);
              if (arrived !== undefined) {
                return Effect.succeed(arrived);
              }
              if (opening.has(id)) {
                // A gate appeared while this waited on `resuming`; let go of it and wait on the gate instead.
                return Effect.succeed(arrived);
              }
              return Effect.gen(function* () {
                const stored = yield* agents.get(asId(id));
                if (stored.meta.archivedAt !== undefined) {
                  return yield* new ConversationArchived({ id });
                }
                const openGate = yield* Deferred.make<boolean>();
                opening.set(id, openGate);
                // `open` claims the Level's resource itself.
                const { entry } = yield* seatIn("none", (claimed) =>
                  Effect.gen(function* () {
                    yield* claimed.assign(id);
                    return { id, seat: yield* agents.open(asId(id)) };
                  })
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : settleOpening(id, openGate)
                  )
                );
                return entry;
              });
            }).pipe(
              resuming.withPermit,
              Effect.flatMap((entry) =>
                entry === undefined ? seatOf(id) : Effect.succeed(entry)
              )
            );
          });

        const send = Effect.fn("Conversations.send")(function* (
          id: number,
          prompt: string,
          files: readonly string[] = [],
          requestId?: string
        ) {
          // A Seat that closes while this send waits for it is resumed again: the send is the newer intent.
          for (let tries = 0; tries < 3; tries += 1) {
            const entry = yield* seatOf(id);
            const submission = yield* sendLive(
              id,
              entry,
              prompt,
              files,
              requestId
            );
            if (submission !== false) {
              return submission;
            }
          }
          return yield* Effect.die(
            new Error(`Conversation ${id} kept losing its Seat`)
          );
        });

        const create = Effect.fn("Conversations.create")(function* (input: {
          readonly owner: UserId;
          readonly sandbox: SandboxChoice;
          readonly software?: readonly SoftwareId[] | undefined;
          readonly prompt: string;
          readonly attachments?: readonly string[] | undefined;
          readonly requestId?: string | undefined;
          readonly approvals?: "ask" | "auto" | undefined;
          readonly settings?: Omit<SettingsChange, "approvals"> | undefined;
        }) {
          const files = input.attachments ?? [];
          // Before the claims in `seatIn`, so bad Software reads as a 400 even with no Seat or Level room left.
          const softwareProblem = checkSoftware(
            input.sandbox,
            normalize(input.software ?? [])
          );
          if (softwareProblem !== undefined) {
            return yield* new InvalidSetting({
              name: "software",
              reason: softwareProblem,
            });
          }
          // Reserved before anything is created, so two creates cannot both take an upload; staged again on failure.
          const reservation =
            files.length === 0 ? undefined : yield* attachments.reserve(files);
          const { id, entry } = yield* seatIn(input.sandbox, (claimed) =>
            Effect.gen(function* () {
              // Claimed first, so a create at a limit records nothing. The title is the prompt as typed.
              const created = yield* agents.create({
                prompt: input.prompt,
                title: titleOf(
                  input.prompt,
                  reservation?.records.map((record) => record.name)
                ),
                level: input.sandbox,
                software: input.software,
                createdAt: yield* Clock.currentTimeMillis,
                owner: input.owner,
                approvals: input.approvals,
                settings: input.settings,
              });
              const createdId = Number(created);
              const gate = yield* Deferred.make<boolean>();
              // Recorded already: until `register` lands the Seat in `live`, look-ups wait on this gate.
              opening.set(createdId, gate);
              return yield* Effect.gen(function* () {
                yield* claimed.assign(createdId);
                yield* reservation?.assign(createdId) ?? Effect.void;
                return {
                  id: createdId,
                  seat: yield* agents.open(
                    created,
                    claimed.levelClaim === undefined
                      ? {}
                      : { levelClaim: claimed.levelClaim }
                  ),
                };
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : settleOpening(createdId, gate)
                )
              );
            })
          ).pipe(Effect.onError(() => reservation?.release ?? Effect.void));
          // A Seat whose first prompt cannot be sent is paused: the Conversation stays, resumable.
          const submission = yield* send(
            id,
            input.prompt,
            files,
            input.requestId
          ).pipe(Effect.onError(() => close(id)));
          const stored = yield* agents.get(asId(id));
          return {
            ...summaryOf(stored, entry, 0, yield* attentionOf(id)),
            submission,
          };
        });

        const resume = Effect.fn("Conversations.resume")(function* (
          id: number
        ) {
          const entry = yield* seatOf(id);
          // Resuming a Seat whose Pause waits for the Run cancels that Pause.
          entry.pausing = false;
          const stored = yield* agents.get(asId(id));
          return summaryOf(stored, entry, 0, yield* attentionOf(id));
        });

        const pause = Effect.fn("Conversations.pause")(function* (id: number) {
          const entry = yield* seatEntry(id);
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
          request: UpgradeRequest
        ) {
          const entry = yield* seatEntry(id);
          if (entry === undefined) {
            const stored = yield* agents.get(asId(id));
            if (stored.meta.archivedAt !== undefined) {
              return yield* new ConversationArchived({ id });
            }
            yield* agents.upgrade(asId(id), request);
          } else {
            yield* entry.seat.upgrade(request).pipe(
              // Held like a send's: `close` waits for the new Sandbox rather than reap the Seat under it.
              entry.lock.withPermit,
              Effect.catchTag("ClaimCancelled", Effect.die)
            );
          }
          const stored = yield* agents.get(asId(id));
          return summaryOf(
            stored,
            live.get(id),
            entry === undefined ? 0 : yield* entry.seat.pendingApprovals,
            yield* attentionOf(id)
          );
        });

        const archive = Effect.fn("Conversations.archive")(function* (
          id: number
        ) {
          const entry = yield* seatEntry(id);
          if (entry !== undefined) {
            yield* entry.seat.stop;
            yield* close(id);
          }
          yield* agents.archive(asId(id), yield* Clock.currentTimeMillis);
          // A stopped seat may have entries its last run-end missed; index them while archived.
          yield* search.indexConversation(asId(id)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Search indexing of conversation ${id} failed`,
                cause
              )
            ),
            Effect.forkIn(layerScope)
          );
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

        const answer = Effect.fn("Conversations.answer")(function* (
          id: number,
          key: string,
          answers?: readonly AnswerInput[]
        ) {
          const entry = live.get(id);
          if (entry === undefined) {
            yield* agents.get(asId(id));
            return yield* new ApprovalNotFound({ key });
          }
          yield* entry.seat.answer(key, answers);
        });

        // A score goes on the trace of the run that wrote the entry; the score id is deterministic, so
        // scoring the same entry again upserts it.
        const score = Effect.fnUntraced(function* (
          id: number,
          input: {
            readonly entry: number;
            readonly name: "feedback" | "report";
            readonly value: number;
            readonly comment?: string | undefined;
          }
        ) {
          const { langfuse } = options;
          if (langfuse === undefined) {
            return yield* new TraceUnavailable({ id, reason: "disabled" });
          }
          const traceId = yield* agents.entryTrace(asId(id), input.entry);
          yield* postScore(langfuse, {
            id: `effect-pi:${input.name}:${id}:${input.entry}`,
            traceId,
            name: input.name,
            value: input.value,
            dataType: "NUMERIC",
            ...(input.comment === undefined ? {} : { comment: input.comment }),
          });
        });

        const feedback = Effect.fn("Conversations.feedback")(function* (
          id: number,
          input: {
            readonly entry: number;
            readonly value: 0 | 1;
            readonly comment?: string | undefined;
          }
        ) {
          yield* score(id, { ...input, name: "feedback" });
        });

        const report = Effect.fn("Conversations.report")(function* (
          id: number,
          input: { readonly entry: number; readonly comment: string }
        ) {
          yield* score(id, { ...input, name: "report", value: 1 });
        });

        const list = Effect.fn("Conversations.list")(function* (owner: UserId) {
          const stored = yield* agents.list;
          const listed: ConversationSummary[] = [];
          for (const each of stored) {
            if (each.meta.owner !== owner) {
              continue;
            }
            const entry = live.get(Number(each.id));
            const pending =
              entry === undefined ? 0 : yield* entry.seat.pendingApprovals;
            listed.push(
              summaryOf(
                each,
                entry,
                pending,
                yield* attentionOf(Number(each.id))
              )
            );
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
          seat: (id) => Effect.sync(() => live.get(id)?.seat),
          resume,
          pause,
          stop,
          upgrade,
          cancelWait: (id) => capacity.cancel(id),
          archive,
          unarchive: (id) => agents.unarchive(asId(id)),
          events: (id) => agents.events(asId(id)),
          history: (id, range) => agents.history(asId(id), range),
          withdraw: (id, submission) => agents.withdraw(asId(id), submission),
          feedback,
          report,
          rename: Effect.fn("Conversations.rename")(function* (id, title) {
            const entry = live.get(id);
            const stored = yield* agents.renameTitle(asId(id), title);
            return summaryOf(
              stored,
              entry,
              entry === undefined ? 0 : yield* entry.seat.pendingApprovals,
              yield* attentionOf(id)
            );
          }),
          generateTitle: Effect.fn("Conversations.generateTitle")(
            function* (id) {
              const entry = live.get(id);
              const stored = yield* agents.generateTitle(asId(id));
              return summaryOf(
                stored,
                entry,
                entry === undefined ? 0 : yield* entry.seat.pendingApprovals,
                yield* attentionOf(id)
              );
            }
          ),
          agent: (id) => agents.agent(asId(id)),
          configure: (id, change) => agents.configure(asId(id), change),
          reset: (id) => agents.reset(asId(id)),
          decide,
          answer,
          capacity: capacity.usage,
        });
      })
    );
}
