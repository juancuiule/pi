// The pure part of Schedules: what a schedule is, resolving "when" in a time zone, the next occurrence, the retry
// backoff, and the block a fired message carries. Only `effect` imports: web/ reads the types through the API.
import { Cron, DateTime, Option, Result } from "effect";

import type { UserId } from "../auth/user.ts";
import { InvalidSchedule } from "../errors.ts";
import { escapeXml } from "../prompt/xml.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import type { SoftwareId } from "../sandbox/software.ts";
import { MARK_CLOSE, MARK_OPEN } from "./marks.ts";

/** The `schedule` tool's name; a subagent's agent has it removed, since a schedule would outlive its task. */
export const SCHEDULE_TOOL = "schedule";

/** When a schedule fires: once at an instant (epoch ms), or at every match of a 5-field cron in its time zone. */
export type ScheduleWhen =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "cron"; readonly cron: string };

/** The settings toggles a new conversation starts with, as the create payload takes them. */
export interface ScheduleToggles {
  readonly extensions?: Readonly<Record<string, boolean>>;
  readonly tools?: Readonly<Record<string, boolean>>;
  readonly skills?: Readonly<Record<string, boolean>>;
}

/** Where a fire lands: a follow-up into an existing Conversation, or a new Conversation per fire. */
export type ScheduleTarget =
  | { readonly kind: "conversation"; readonly conversation: number }
  | {
      readonly kind: "new";
      readonly level: SandboxChoice;
      readonly software: readonly SoftwareId[];
      readonly approvals: "ask" | "auto";
      readonly settings?: ScheduleToggles;
    };

/** `active` fires; `paused` keeps it without firing; `done` (a one-time schedule that fired) and `cancelled` are final. */
export type ScheduleStatus = "active" | "paused" | "done" | "cancelled";

/** One occurrence: sent (the message went in), missed (no room before the retries ran out) or failed. */
export interface ScheduleRun {
  /** The occurrence it was for, epoch ms. */
  readonly due: number;
  readonly firedAt: number;
  readonly status: "sent" | "missed" | "failed";
  /** Fired more than a minute after `due`: after downtime, or after waiting for room. */
  readonly late: boolean;
  /** The Conversation the message went into. */
  readonly conversation?: number;
  readonly detail?: string;
}

export interface Schedule {
  readonly id: string;
  readonly owner: UserId;
  readonly title: string;
  /** The message each fire sends, as the person or the agent wrote it. */
  readonly prompt: string;
  readonly when: ScheduleWhen;
  /** IANA zone the schedule's wall-clock times are in, copied from the User's when it was made. */
  readonly timeZone: string;
  readonly target: ScheduleTarget;
  readonly status: ScheduleStatus;
  /** The next occurrence while active or paused; absent once final. */
  readonly nextAt?: number;
  /** When the next try of a fire that found no room is due; absent unless waiting for room. */
  readonly retryAt?: number;
  /** Tries of the current occurrence that found no room. */
  readonly attempts: number;
  /** The occurrence a new-conversation fire is creating, so a restart can tell whether it happened. */
  readonly firing?: number;
  readonly createdAt: number;
  readonly createdBy: "person" | "agent";
  /** The Conversation whose agent made it. */
  readonly origin?: number;
  readonly lastRun?: ScheduleRun;
  /** Why it ended, for a cancelled one the server ended. */
  readonly detail?: string;
}

/** "When", as the person or the agent says it; resolved against a time zone and the current time. */
export type WhenInput =
  /** A local date-time in the zone (`2026-11-04T09:00`), or an ISO instant with an offset or `Z`. */
  | { readonly at: string }
  | { readonly inMinutes: number }
  /** Five fields: minute hour day-of-month month day-of-week, in the zone. */
  | { readonly cron: string };

/** The zone's own spelling when it names an IANA zone; `undefined` otherwise. */
export const validZone = (zone: string): string | undefined =>
  zone.trim() !== "" &&
  Option.isSome(DateTime.zoneMakeNamed(zone)) &&
  // Offsets like "+03:00" parse as zones too; only names are kept, so DST follows the place.
  /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(zone)
    ? zone
    : undefined;

export const MIN_GAP_MS = 5 * 60_000;
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
/** A one-time schedule may be this far in the past (the clock moved while it was typed); it fires at once. */
const PAST_GRACE_MS = 60_000;
/** A fire this long after its occurrence counts as late. */
export const LATE_MS = 60_000;
/** How long a fire keeps retrying for room before the occurrence is missed. */
export const RETRY_WINDOW_MS = 60 * 60_000;
export const MAX_ACTIVE = 50;

/** Wait before try `attempt + 1` of a fire that found no room: 1, 2, 4, 8, then 15 minutes. */
export const retryDelay = (attempt: number): number =>
  Math.min(15, 2 ** Math.max(0, attempt - 1)) * 60_000;

const LOCAL =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[T ](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;

const invalid = (field: string, reason: string) =>
  new InvalidSchedule({ field, reason });

const parseCron = (cron: string, zone: string) => {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return Result.fail(
      invalid(
        "cron",
        "A cron needs exactly five fields: minute hour day-of-month month day-of-week, e.g. `0 9 * * 1-5`."
      )
    );
  }
  return Cron.parse(fields.join(" "), zone).pipe(
    Result.mapError(() =>
      invalid(
        "cron",
        `\`${cron}\` is not a cron: five fields, minute hour day-of-month month day-of-week, e.g. \`0 9 * * 1-5\`.`
      )
    )
  );
};

/** The first occurrence of `cron` in `zone` strictly after `after`; `undefined` when it never matches. */
export const nextCron = (
  cron: string,
  zone: string,
  after: number
): number | undefined => {
  const parsed = parseCron(cron, zone);
  if (Result.isFailure(parsed)) {
    return undefined;
  }
  try {
    return Cron.next(parsed.success, new Date(after)).getTime();
  } catch {
    return undefined;
  }
};

/** `ms` as the zone's wall clock: `Wed, Nov 4, 2026, 09:00 (America/New_York)`. */
export const formatLocal = (ms: number, zone: string): string => {
  const zoned = DateTime.makeZoned(ms, { timeZone: zone });
  if (Option.isNone(zoned)) {
    return new Date(ms).toISOString();
  }
  const text = DateTime.format(zoned.value, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${text} (${zone})`;
};

/** `ms` as an ISO time with the zone's offset, `2026-11-04T09:00:00.000-03:00`. */
export const isoInZone = (ms: number, zone: string): string => {
  const zoned = DateTime.makeZoned(ms, { timeZone: zone });
  return Option.isNone(zoned)
    ? new Date(ms).toISOString()
    : DateTime.formatIsoOffset(zoned.value);
};

/**
 * `input` as a schedule's `when` and its first occurrence, in `zone` at `now`. Fails with the sentence the caller
 * reads: a past or far-off time, a cron that never matches, or one that fires more often than every 5 minutes.
 */
export const resolveWhen = (
  input: WhenInput,
  zone: string,
  now: number
): Result.Result<
  { readonly when: ScheduleWhen; readonly nextAt: number },
  InvalidSchedule
> => {
  if ("cron" in input) {
    const parsed = parseCron(input.cron, zone);
    if (Result.isFailure(parsed)) {
      return Result.fail(parsed.failure);
    }
    const cron = input.cron.trim().split(/\s+/u).join(" ");
    const first = nextCron(cron, zone, now);
    if (first === undefined || first - now > MAX_AHEAD_MS) {
      return Result.fail(
        invalid("cron", `\`${cron}\` does not match any time in the next year.`)
      );
    }
    // The gap between occurrences, over the next few; a cron like `*/2 9 * * *` is frequent only inside its hour.
    let previous = first;
    for (let index = 0; index < 24; index += 1) {
      const following = nextCron(cron, zone, previous);
      if (following === undefined) {
        break;
      }
      if (following - previous < MIN_GAP_MS) {
        return Result.fail(
          invalid(
            "cron",
            `\`${cron}\` fires more often than every 5 minutes, which a schedule may not.`
          )
        );
      }
      previous = following;
    }
    return Result.succeed({ when: { kind: "cron", cron }, nextAt: first });
  }
  let at: number;
  if ("inMinutes" in input) {
    if (!Number.isFinite(input.inMinutes) || input.inMinutes < 1) {
      return Result.fail(
        invalid("in_minutes", "`in_minutes` must be at least 1.")
      );
    }
    at = now + Math.round(input.inMinutes * 60_000);
  } else {
    const text = input.at.trim();
    const local = LOCAL.exec(text)?.groups;
    const resolved: Option.Option<DateTime.DateTime> =
      local === undefined
        ? DateTime.make(text)
        : DateTime.makeZoned(
            {
              year: Number(local.year),
              month: Number(local.month),
              day: Number(local.day),
              hour: Number(local.hour),
              minute: Number(local.minute),
              second: Number(local.second ?? 0),
            },
            { timeZone: zone, adjustForTimeZone: true }
          );
    // A bare date-time without an offset is the zone's wall clock; anything else must say its offset.
    if (
      Option.isNone(resolved) ||
      (local === undefined && !/(?:Z|[+-]\d{2}:?\d{2})$/u.test(text))
    ) {
      return Result.fail(
        invalid(
          "at",
          `\`${input.at}\` is not a time: use a local date-time like 2026-11-04T09:00 (in ${zone}) or an ISO time with an offset.`
        )
      );
    }
    at = DateTime.toEpochMillis(resolved.value);
  }
  if (at < now - PAST_GRACE_MS) {
    return Result.fail(
      invalid(
        "at",
        `${formatLocal(at, zone)} is in the past; it is ${formatLocal(now, zone)} now.`
      )
    );
  }
  if (at - now > MAX_AHEAD_MS) {
    return Result.fail(
      invalid("at", "A schedule may be at most a year ahead.")
    );
  }
  return Result.succeed({
    when: { kind: "once", at },
    nextAt: Math.max(at, now),
  });
};

/** The schedule's when, in a few words for the model's list. */
export const describeWhen = (schedule: Pick<Schedule, "when" | "timeZone">) =>
  schedule.when.kind === "once"
    ? `once at ${formatLocal(schedule.when.at, schedule.timeZone)}`
    : `cron \`${schedule.when.cron}\` (${schedule.timeZone})`;

/** The occurrence after `due` a fire at `now` leaves next: later than both, so missed occurrences are skipped. */
export const followingOccurrence = (
  schedule: Pick<Schedule, "when" | "timeZone">,
  due: number,
  now: number
): number | undefined =>
  schedule.when.kind === "once"
    ? undefined
    : nextCron(schedule.when.cron, schedule.timeZone, Math.max(due, now));

/** What a fired message says about itself; the console reads it back with `splitScheduleMark` (web/lib/schedules.ts). */
export interface ScheduleMark {
  readonly id: string;
  readonly title: string;
  readonly due: number;
  readonly timeZone: string;
}

/**
 * The block that leads a fired message, so the model knows the person did not type it just now and the console can
 * show it as scheduled. `\n\n` separates it from the message.
 */
export const scheduleBlock = (mark: ScheduleMark): string =>
  [
    `${MARK_OPEN}schedule="${escapeXml(mark.id)}" title="${escapeXml(mark.title)}" due="${isoInZone(mark.due, mark.timeZone)}">`,
    "A schedule sent this message at its due time; the person did not type it just now. Do what it asks, then answer as usual.",
    MARK_CLOSE,
  ].join("\n");

/** What a person typed can never pass for a block the server added. */
export const escapeScheduleTags = (text: string): string =>
  text.replaceAll(
    /<(?<slash>\/?)scheduled_run/giu,
    "<$<slash>\u200Bscheduled_run"
  );

export {
  isScheduledRequest,
  MARK_CLOSE,
  MARK_OPEN,
  scheduleRequestId,
} from "./marks.ts";
