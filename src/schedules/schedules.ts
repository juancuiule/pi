// Schedules (#77): work a User asks for later or repeatedly, kept in EFFECT_PI_DB (store.ts) and fired by the
// Scheduler (scheduler.ts). This module is the validated side — create, list, pause, resume, cancel, each User's time
// zone — and the `schedules` extension: a prompt section with the person's zone and date, and the `schedule` tool,
// whose create and cancel wait for approval under `ask`. Decisions: docs/adr/0010-schedules-fire-through-seats.md.
import { randomBytes } from "node:crypto";

import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Queue,
  Result,
} from "effect";

import { ApprovalDoc, conversationRoot, withApproval } from "../approvals.ts";
import type { UserId } from "../auth/user.ts";
import { conversationOwner } from "../conversation-meta.ts";
import { InvalidSchedule, ScheduleNotFound } from "../errors.ts";
import { SandboxDoc } from "../sandbox/sandbox.ts";
import { checkSoftware, normalize } from "../sandbox/software.ts";
import { WorkspaceDoc } from "../workspaces/workspaces.ts";
import {
  describeWhen,
  formatLocal,
  MAX_ACTIVE,
  nextCron,
  resolveWhen,
  SCHEDULE_TOOL,
  validZone,
} from "./format.ts";
import type {
  Schedule,
  ScheduleRun,
  ScheduleTarget,
  WhenInput,
} from "./format.ts";
import { sqliteSchedules } from "./store.ts";
import type { ScheduleRecords } from "./store.ts";

/** The zone of a User who never reported one. */
export const DEFAULT_ZONE = "UTC";

const TITLE_MAX = 120;
const PROMPT_MAX = 20_000;

export interface ScheduleInput {
  readonly title: string;
  readonly prompt: string;
  readonly when: WhenInput;
  /** The zone its wall-clock times are in; the owner's by default. */
  readonly timeZone?: string | undefined;
  readonly target: ScheduleTarget;
  readonly createdBy: "person" | "agent";
  /** The Conversation whose agent made it. */
  readonly origin?: number | undefined;
}

const newId = () => `sch_${randomBytes(9).toString("base64url")}`;

export class Schedules extends Context.Service<
  Schedules,
  {
    /** Validate and keep a schedule for `owner`; its first occurrence is computed now. */
    create(
      owner: UserId,
      input: ScheduleInput
    ): Effect.Effect<Schedule, InvalidSchedule>;
    /** `owner`'s schedules, newest first; with `conversation`, the follow-ups into it. */
    list(
      owner: UserId,
      conversation?: number
    ): Effect.Effect<readonly Schedule[]>;
    get(owner: UserId, id: string): Effect.Effect<Schedule, ScheduleNotFound>;
    /** A schedule's recent runs, newest first. */
    runs(
      owner: UserId,
      id: string
    ): Effect.Effect<readonly ScheduleRun[], ScheduleNotFound>;
    /** Stop firing until resumed; a final schedule is left as it is. */
    pause(owner: UserId, id: string): Effect.Effect<Schedule, ScheduleNotFound>;
    /** Fire again: a recurring one from its next occurrence after now, a one-time one at its time (at once if past). */
    resume(
      owner: UserId,
      id: string
    ): Effect.Effect<Schedule, ScheduleNotFound>;
    /** End it for good; it stays listed as cancelled. */
    cancel(
      owner: UserId,
      id: string
    ): Effect.Effect<Schedule, ScheduleNotFound>;
    /** The zone `owner`'s new schedules use, and whether their browser reported it. */
    timeZone(
      owner: UserId
    ): Effect.Effect<{ readonly timeZone: string; readonly reported: boolean }>;
    setTimeZone(
      owner: UserId,
      zone: string
    ): Effect.Effect<string, InvalidSchedule>;
    /** The scheduler's side: every active schedule due now. */
    readonly due: Effect.Effect<readonly Schedule[]>;
    /** The scheduler's side: the earliest wake of any active schedule. */
    readonly nextWake: Effect.Effect<number | undefined>;
    /** The scheduler's side: completes at the next change to any schedule (or one already signalled). */
    readonly changed: Effect.Effect<void>;
    /** The scheduler's side: a schedule as stored now, whoever owns it. */
    current(id: string): Effect.Effect<Schedule | undefined>;
    /** The scheduler's side: replace a schedule's row; `false` when it is gone. */
    save(schedule: Schedule): Effect.Effect<boolean>;
    /** The scheduler's side: record an occurrence's outcome and make it the schedule's last run. */
    recordRun(schedule: Schedule, run: ScheduleRun): Effect.Effect<Schedule>;
  }
>()("effect-pi/Schedules") {
  static readonly layer = (options: { readonly records: ScheduleRecords }) =>
    Layer.effect(
      Schedules,
      Effect.gen(function* () {
        const { records } = options;
        const signal = yield* Queue.sliding<boolean>(1);
        const changed = Queue.offer(signal, true).pipe(Effect.asVoid);

        const owned = (owner: UserId, id: string) =>
          Effect.suspend(() => {
            const schedule = records.get(id);
            return schedule === undefined || schedule.owner !== owner
              ? Effect.fail(new ScheduleNotFound({ id }))
              : Effect.succeed(schedule);
          });

        const store = (schedule: Schedule) =>
          Effect.sync(() => records.update(schedule)).pipe(
            Effect.tap(() => changed),
            Effect.as(schedule)
          );

        const zoneOf = (owner: UserId) =>
          Effect.sync(() => records.timeZone(owner));

        const create = Effect.fn("Schedules.create")(function* (
          owner: UserId,
          input: ScheduleInput
        ) {
          const title = input.title.trim();
          if (title === "" || title.length > TITLE_MAX) {
            return yield* new InvalidSchedule({
              field: "title",
              reason: `A schedule needs a title of at most ${TITLE_MAX} characters.`,
            });
          }
          if (input.prompt.trim() === "" || input.prompt.length > PROMPT_MAX) {
            return yield* new InvalidSchedule({
              field: "prompt",
              reason: `A schedule needs a message to send, at most ${PROMPT_MAX} characters.`,
            });
          }
          const zone = validZone(
            input.timeZone ?? (yield* zoneOf(owner)) ?? DEFAULT_ZONE
          );
          if (zone === undefined) {
            return yield* new InvalidSchedule({
              field: "timeZone",
              reason: `\`${input.timeZone}\` is not an IANA time zone such as Europe/Madrid.`,
            });
          }
          if (input.target.kind === "new") {
            const problem = checkSoftware(
              input.target.level,
              normalize(input.target.software)
            );
            if (problem !== undefined) {
              return yield* new InvalidSchedule({
                field: "software",
                reason: problem,
              });
            }
          }
          if (records.countActive(owner) >= MAX_ACTIVE) {
            return yield* new InvalidSchedule({
              field: "when",
              reason: `At most ${MAX_ACTIVE} schedules can be active or paused at once; cancel one first.`,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const resolved = resolveWhen(input.when, zone, now);
          if (Result.isFailure(resolved)) {
            return yield* resolved.failure;
          }
          const schedule: Schedule = {
            id: newId(),
            owner,
            title,
            prompt: input.prompt,
            when: resolved.success.when,
            timeZone: zone,
            target:
              input.target.kind === "new"
                ? {
                    ...input.target,
                    software: normalize(input.target.software),
                  }
                : input.target,
            status: "active",
            nextAt: resolved.success.nextAt,
            attempts: 0,
            createdAt: now,
            createdBy: input.createdBy,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
          };
          records.insert(schedule);
          yield* changed;
          return schedule;
        });

        const pause = Effect.fn("Schedules.pause")(function* (
          owner: UserId,
          id: string
        ) {
          const schedule = yield* owned(owner, id);
          if (schedule.status !== "active") {
            return schedule;
          }
          const { retryAt: _retry, ...rest } = schedule;
          return yield* store({ ...rest, status: "paused", attempts: 0 });
        });

        const resume = Effect.fn("Schedules.resume")(function* (
          owner: UserId,
          id: string
        ) {
          const schedule = yield* owned(owner, id);
          if (schedule.status !== "paused") {
            return schedule;
          }
          const now = yield* Clock.currentTimeMillis;
          // Occurrences that passed while paused are skipped; a one-time schedule whose time passed fires now.
          const nextAt =
            schedule.when.kind === "once"
              ? schedule.when.at
              : nextCron(schedule.when.cron, schedule.timeZone, now);
          if (nextAt === undefined) {
            const { nextAt: _next, ...rest } = schedule;
            return yield* store({ ...rest, status: "done" });
          }
          return yield* store({ ...schedule, status: "active", nextAt });
        });

        const cancel = Effect.fn("Schedules.cancel")(function* (
          owner: UserId,
          id: string
        ) {
          const schedule = yield* owned(owner, id);
          if (schedule.status === "done" || schedule.status === "cancelled") {
            return schedule;
          }
          const { retryAt: _retry, nextAt: _next, ...rest } = schedule;
          return yield* store({ ...rest, status: "cancelled", attempts: 0 });
        });

        return Schedules.of({
          create,
          list: (owner, conversation) =>
            Effect.sync(() => records.list(owner, conversation)),
          get: owned,
          runs: (owner, id) =>
            owned(owner, id).pipe(Effect.map(() => records.runs(id))),
          pause,
          resume,
          cancel,
          timeZone: (owner) =>
            zoneOf(owner).pipe(
              Effect.map((zone) => ({
                timeZone: zone ?? DEFAULT_ZONE,
                reported: zone !== undefined,
              }))
            ),
          setTimeZone: (owner, zone) => {
            const valid = validZone(zone);
            return valid === undefined
              ? Effect.fail(
                  new InvalidSchedule({
                    field: "timeZone",
                    reason: `\`${zone}\` is not an IANA time zone such as Europe/Madrid.`,
                  })
                )
              : Clock.currentTimeMillis.pipe(
                  Effect.map((at) => {
                    records.setTimeZone(owner, valid, at);
                    return valid;
                  })
                );
          },
          due: Clock.currentTimeMillis.pipe(
            Effect.map((now) => records.due(now))
          ),
          nextWake: Effect.sync(() => records.nextWake()),
          changed: Effect.asVoid(Queue.take(signal)),
          current: (id) => Effect.sync(() => records.get(id)),
          save: (schedule) =>
            Effect.sync(() => records.update(schedule)).pipe(
              Effect.tap(() => changed)
            ),
          recordRun: (schedule, run) =>
            Effect.sync(() => {
              records.addRun(schedule.id, run);
              const next = { ...schedule, lastRun: run };
              records.update(next);
              return next;
            }).pipe(Effect.tap(() => changed)),
        });
      })
    );

  /** The tables in a SQLite file, created if missing. */
  static readonly local = (options: { readonly database: string }) =>
    Layer.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => sqliteSchedules(options.database)),
        (records) => Effect.sync(() => records.close())
      ).pipe(Effect.map((records) => Schedules.layer({ records })))
    );

  /** Empty tables in memory; for tests. */
  static readonly temporary = () => Schedules.local({ database: ":memory:" });
}

const pad = (value: number) => String(value).padStart(2, "0");

const textResult = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

/** Today's date in `zone`: `Wednesday, 2026-11-04`. */
const todayIn = (now: number, zone: string) => {
  const zoned = DateTime.makeZoned(now, { timeZone: zone });
  if (Option.isNone(zoned)) {
    return new Date(now).toISOString().slice(0, 10);
  }
  const parts = DateTime.toParts(zoned.value);
  const weekday = DateTime.format(zoned.value, { weekday: "long" });
  return `${weekday}, ${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
};

/** What the agent is told about scheduling: the person's zone and today's date there, which changes once a day. */
export const schedulesSection = (zone: string, now: number): string =>
  [
    'With the `schedule` tool you can do work later: a follow-up message into this conversation (`where: "here"`: "remind me in an hour", "check again tomorrow"), or a new conversation per run from a saved prompt (`where: "new_conversation"`: "summarize the news every morning").',
    `The person's time zone is ${zone}; today there is ${todayIn(now, zone)}.`,
    'Resolve what they say into a concrete time before calling: `in_minutes` for "in N minutes or hours", `at` as a local date-time in their zone (`2026-11-05T09:00`) for a day and time, `cron` (five fields, in their zone) for repeating ones — "every weekday at 9" is `0 9 * * 1-5`. When it is unclear which time they mean, ask.',
    "The prompt is sent as written when it fires. A new conversation does not see this one, so make its prompt self-contained.",
    "Say the time from the tool's result in your answer, so the person can check it.",
  ].join("\n");

const Parameters = Type.Object({
  action: Type.Union(
    [Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")],
    { description: "What to do" }
  ),
  title: Type.Optional(
    Type.String({ description: "create: a short name the person sees" })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "create: the message to send when it fires",
    })
  ),
  where: Type.Optional(
    Type.Union([Type.Literal("here"), Type.Literal("new_conversation")], {
      description:
        "create: `here` sends into this conversation (default); `new_conversation` opens a new one per run, with this conversation's machine and approval policy",
    })
  ),
  at: Type.Optional(
    Type.String({
      description:
        "create, one time: a local date-time in the person's zone (2026-11-05T09:00), or an ISO time with an offset",
    })
  ),
  in_minutes: Type.Optional(
    Type.Number({ description: "create, one time: minutes from now" })
  ),
  cron: Type.Optional(
    Type.String({
      description:
        "create, repeating: five-field cron in the person's zone, e.g. `0 9 * * 1-5`",
    })
  ),
  id: Type.Optional(Type.String({ description: "cancel: the schedule's id" })),
});

const listLine = (schedule: Schedule) =>
  [
    `- ${schedule.id} "${schedule.title}" (${schedule.status}): ${describeWhen(schedule)}`,
    schedule.target.kind === "conversation"
      ? `into conversation ${schedule.target.conversation}`
      : "a new conversation per run",
    ...(schedule.nextAt === undefined || schedule.status !== "active"
      ? []
      : [`next ${formatLocal(schedule.nextAt, schedule.timeZone)}`]),
  ].join(", ");

const whenOf = (args: {
  readonly at?: string | undefined;
  readonly in_minutes?: number | undefined;
  readonly cron?: string | undefined;
}): WhenInput => {
  const given = [
    args.at === undefined ? [] : [{ at: args.at }],
    args.in_minutes === undefined ? [] : [{ inMinutes: args.in_minutes }],
    args.cron === undefined ? [] : [{ cron: args.cron }],
  ].flat();
  const [only] = given;
  if (given.length !== 1 || only === undefined) {
    throw new Error("Give exactly one of `at`, `in_minutes` or `cron`.");
  }
  return only;
};

const sentenceOf = (failure: unknown) =>
  typeof failure === "object" && failure !== null && "reason" in failure
    ? String(failure.reason)
    : String(failure);

// A failure reaches the model as its sentence: InvalidSchedule's `reason`, else the error itself.
const runWith = <A, E>(
  services: Context.Context<never>,
  effect: Effect.Effect<A, E>
) =>
  Effect.runPromiseWith(services)(
    Effect.mapError(effect, (failure) => new Error(sentenceOf(failure)))
  );

/**
 * The prompt section and the `schedule` tool, over the conversation owner's schedules. `services` is what the calls
 * run with — the layer's, so its Clock is the one the scheduler reads.
 */
export const schedulesExtension = (
  schedules: Schedules["Service"],
  services: Context.Context<never> = Context.empty()
): Extension => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => runWith(services, effect);
  const now = () => run(Clock.currentTimeMillis);
  return defineExtension({
    name: "schedules",
    sections: [
      section("schedules", async (input, context) => {
        const owner = await conversationOwner(
          input.read,
          input.conversationId,
          context
        );
        const zone =
          owner === undefined
            ? undefined
            : await run(schedules.timeZone(owner));
        const at = await now();
        return schedulesSection(zone?.timeZone ?? DEFAULT_ZONE, at);
      }),
    ],
    tools: [
      withApproval(
        defineTool({
          name: SCHEDULE_TOOL,
          description:
            "Schedule a message for later or on a repeat, list this person's schedules, or cancel one. A follow-up lands in this conversation; a new-conversation schedule opens a fresh conversation for every run.",
          parameters: Parameters,
          // Writes a row the scheduler fires: never rerun blindly after a crash.
          replay: "unsafe",
          execute: async (args, api, context) => {
            const owner = await conversationOwner(
              api,
              api.conversationId,
              context
            );
            if (owner === undefined) {
              throw new Error(
                "This conversation has no owner to schedule for."
              );
            }
            const here = await conversationRoot(
              api,
              api.conversationId,
              context
            );
            if (args.action === "list") {
              const listed = await run(schedules.list(owner));
              const all = listed.filter(
                (schedule) =>
                  schedule.status === "active" || schedule.status === "paused"
              );
              return textResult(
                all.length === 0
                  ? "No active schedules."
                  : all.map(listLine).join("\n")
              );
            }
            if (args.action === "cancel") {
              if (args.id === undefined) {
                throw new Error("Give the `id` of the schedule to cancel.");
              }
              const cancelled = await run(schedules.cancel(owner, args.id));
              return textResult(
                `Cancelled ${cancelled.id} "${cancelled.title}".`
              );
            }
            if (args.title === undefined || args.prompt === undefined) {
              throw new Error("A new schedule needs a `title` and a `prompt`.");
            }
            let target: ScheduleTarget = {
              kind: "conversation",
              conversation: Number(here),
            };
            if (args.where === "new_conversation") {
              // A task-owned conversation works on its owner's machine; its own WorkspaceDoc stays "none".
              const sandbox = await api.snapshot(SandboxDoc, here, context);
              const machine =
                sandbox?.owner === undefined
                  ? here
                  : (Number(sandbox.owner) as typeof here);
              const workspace = await api.snapshot(
                WorkspaceDoc,
                machine,
                context
              );
              const approvals = await api.snapshot(ApprovalDoc, here, context);
              target = {
                kind: "new",
                level: workspace?.level ?? "none",
                software: workspace?.software ?? [],
                approvals: approvals?.policy === "ask" ? "ask" : "auto",
              };
            }
            const created = await run(
              schedules.create(owner, {
                title: args.title,
                prompt: args.prompt,
                when: whenOf(args),
                target,
                createdBy: "agent",
                origin: Number(here),
              })
            );
            const next =
              created.nextAt === undefined
                ? "never"
                : formatLocal(created.nextAt, created.timeZone);
            return {
              ...textResult(
                `Scheduled ${created.id} "${created.title}", ${describeWhen(created)}${
                  created.target.kind === "new"
                    ? ", in a new conversation each run"
                    : ", into this conversation"
                }. Next run: ${next}. It is ${formatLocal(await now(), created.timeZone)} now.`
              ),
              details: { schedule: created.id },
            };
          },
        }),
        // Listing changes nothing; creating and cancelling do.
        { when: (args) => (args as { action?: string }).action !== "list" }
      ),
    ],
  });
};
