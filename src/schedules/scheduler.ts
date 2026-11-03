// The Scheduler: a background fiber that fires due schedules through `Conversations`, like a person's send. It sleeps
// until the earliest wake (capped, and cut short by any change to a schedule), so it reads `Clock` and runs under
// TestClock. Restart-safe: a follow-up's submission carries `schedule:<id>:<due>`, so firing it again is the same
// submission; a new-conversation fire records the occurrence it is creating, and the Conversation's metadata names
// it, so a restart finds a fire that happened before re-creating it. An overdue schedule fires once on boot, then a
// recurring one skips to its next occurrence after now. Decisions: docs/adr/0012-schedules-fire-through-seats.md.
import { Cause, Clock, Effect, Exit, Layer, Option, Scope } from "effect";

import { Conversations } from "../server/conversations.ts";
import {
  followingOccurrence,
  LATE_MS,
  RETRY_WINDOW_MS,
  retryDelay,
  scheduleRequestId,
} from "./format.ts";
import type { Schedule, ScheduleRun } from "./format.ts";
import { Schedules } from "./schedules.ts";

/** The longest the scheduler sleeps between looks, so a clock jump or a missed signal costs at most this. */
const MAX_SLEEP_MS = 60_000;

/** What became of one try of a fire. */
type Outcome =
  | { readonly kind: "sent"; readonly conversation: number }
  | { readonly kind: "full"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  /** The follow-up's Conversation cannot take messages any more; the schedule ends. */
  | { readonly kind: "gone"; readonly detail: string };

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;

const outcomeOf = (failure: unknown): Outcome => {
  const tag = tagOf(failure);
  switch (tag) {
    case "CapacityExhausted": {
      const { resource, limit } = failure as {
        resource: string;
        limit: number;
      };
      return {
        kind: "full",
        detail: `No room: the server's ${resource} limit (${limit}) was reached.`,
      };
    }
    case "ConversationArchived": {
      return { kind: "gone", detail: "Its conversation was archived." };
    }
    case "ConversationNotFound": {
      return { kind: "gone", detail: "Its conversation no longer exists." };
    }
    case "SkillNotFound": {
      const { name } = failure as { name: string };
      return {
        kind: "failed",
        detail: `The prompt forces the skill \`${name}\`, which does not exist.`,
      };
    }
    case "InvalidSetting": {
      const { reason } = failure as { reason: string };
      return { kind: "failed", detail: reason };
    }
    default: {
      return {
        kind: "failed",
        detail: `The run could not start: ${tag ?? String(failure)}.`,
      };
    }
  }
};

const failureOutcome = (cause: Cause.Cause<unknown>): Outcome => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure)
    ? outcomeOf(failure.value)
    : {
        kind: "failed",
        detail: "The run could not start: the server failed.",
      };
};

export const Scheduler = {
  layer: (options: { readonly maxSleepMs?: number } = {}) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const schedules = yield* Schedules;
        const conversations = yield* Conversations;
        const scope = yield* Scope.Scope;
        const maxSleepMs = options.maxSleepMs ?? MAX_SLEEP_MS;
        // Fires going on now, so a slow one (a first Software build) is not started twice.
        const inflight = new Set<string>();

        // One try of the occurrence `due`.
        const attempt = (schedule: Schedule, due: number) =>
          Effect.gen(function* () {
            const mark = {
              id: schedule.id,
              title: schedule.title,
              due,
              timeZone: schedule.timeZone,
            };
            const { target } = schedule;
            if (target.kind === "conversation") {
              const exit = yield* Effect.exit(
                conversations.send(
                  target.conversation,
                  schedule.prompt,
                  [],
                  scheduleRequestId(schedule.id, due),
                  { schedule: mark }
                )
              );
              return Exit.isSuccess(exit)
                ? ({
                    kind: "sent",
                    conversation: target.conversation,
                  } satisfies Outcome)
                : failureOutcome(exit.cause);
            }
            // Created before this restart? Its metadata names the occurrence.
            if (schedule.firing === due) {
              const existing = (yield* conversations
                .list(schedule.owner)
                .pipe(Effect.orDie)).find(
                (summary) =>
                  summary.schedule?.id === schedule.id &&
                  summary.schedule.due === due
              );
              if (existing !== undefined) {
                return {
                  kind: "sent",
                  conversation: existing.id,
                } satisfies Outcome;
              }
            }
            yield* schedules.save({ ...schedule, firing: due });
            const exit = yield* Effect.exit(
              conversations.create({
                owner: schedule.owner,
                sandbox: target.level,
                software: target.software,
                prompt: schedule.prompt,
                requestId: scheduleRequestId(schedule.id, due),
                approvals: target.approvals,
                ...(target.settings === undefined
                  ? {}
                  : { settings: target.settings }),
                title: schedule.title,
                schedule: mark,
              })
            );
            return Exit.isSuccess(exit)
              ? ({
                  kind: "sent",
                  conversation: exit.value.id,
                } satisfies Outcome)
              : failureOutcome(exit.cause);
          });

        // Fire `fetched`'s current occurrence and move it on. Its row is read again at the end: a pause or a cancel
        // that came during the fire is kept.
        const fire = (fetched: Schedule) =>
          Effect.gen(function* () {
            const due = fetched.nextAt;
            if (due === undefined) {
              return;
            }
            const outcome = yield* attempt(fetched, due);
            if (outcome.kind === "failed" || outcome.kind === "gone") {
              yield* Effect.logWarning(
                `Schedule ${fetched.id} did not fire: ${outcome.detail}`
              );
            }
            const now = yield* Clock.currentTimeMillis;
            const current = yield* schedules.current(fetched.id);
            if (current === undefined) {
              return;
            }
            const late = now - due >= LATE_MS;
            if (outcome.kind === "full") {
              const attempts = current.attempts + 1;
              const retryAt = now + retryDelay(attempts);
              const following = followingOccurrence(current, due, now);
              const giveUp =
                retryAt - due > RETRY_WINDOW_MS ||
                (following !== undefined && retryAt >= following);
              if (!giveUp && current.status === "active") {
                const { firing: _firing, ...rest } = current;
                yield* schedules.save({ ...rest, attempts, retryAt });
                return;
              }
            }
            const run: ScheduleRun = {
              due,
              firedAt: now,
              status:
                // oxlint-disable-next-line no-nested-ternary -- three outcomes, one field
                outcome.kind === "sent"
                  ? "sent"
                  : outcome.kind === "full"
                    ? "missed"
                    : "failed",
              late,
              ...(outcome.kind === "sent"
                ? { conversation: outcome.conversation }
                : { detail: outcome.detail }),
            };
            const {
              firing: _firing,
              retryAt: _retryAt,
              nextAt: _nextAt,
              ...rest
            } = current;
            let next: Schedule = { ...rest, attempts: 0 };
            if (current.status === "active" || current.status === "paused") {
              const nextAt =
                outcome.kind === "gone"
                  ? undefined
                  : followingOccurrence(current, due, now);
              if (nextAt !== undefined) {
                next = { ...next, nextAt };
              } else if (outcome.kind === "gone") {
                next = { ...next, status: "cancelled", detail: outcome.detail };
              } else {
                next = { ...next, status: "done" };
              }
            } else if (current.nextAt !== undefined) {
              next = { ...next, nextAt: current.nextAt };
            }
            yield* schedules.recordRun(next, run);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`Schedule ${fetched.id} failed to fire`, cause)
            ),
            Effect.ensuring(Effect.sync(() => inflight.delete(fetched.id)))
          );

        const tick = Effect.gen(function* () {
          for (const schedule of yield* schedules.due) {
            if (inflight.has(schedule.id)) {
              continue;
            }
            inflight.add(schedule.id);
            yield* fire(schedule).pipe(Effect.forkIn(scope));
          }
        });

        const loop = Effect.gen(function* () {
          for (;;) {
            yield* tick;
            const now = yield* Clock.currentTimeMillis;
            const wake = yield* schedules.nextWake;
            // A wake at or before now belongs to a fire in flight; its end is a change, which wakes this loop.
            const wait =
              wake === undefined || wake <= now
                ? maxSleepMs
                : Math.min(maxSleepMs, wake - now);
            yield* Effect.raceFirst(Effect.sleep(wait), schedules.changed);
          }
        });

        yield* loop.pipe(Effect.forkIn(scope));
      })
    ),
};
