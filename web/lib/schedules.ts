// Pure helpers for schedules in the console: reading a fired message's block back (the server writes it, see
// src/schedules/format.ts `scheduleBlock`), describing when a schedule fires, and turning the form's choices into
// the API's `when`.
import type { Schedule, ScheduleRun, WhenInput } from "effect-pi/api";
import { MARK_CLOSE, MARK_OPEN } from "effect-pi/api";

export interface ScheduleMarkInfo {
  readonly schedule: string;
  readonly title: string;
  /** The occurrence, as the ISO time with offset the block carries. */
  readonly due: string;
}

const unescape = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const attribute = (tag: string, name: string): string | undefined => {
  const start = tag.indexOf(` ${name}="`);
  if (start === -1) {
    return undefined;
  }
  const from = start + name.length + 3;
  const end = tag.indexOf('"', from);
  return end === -1 ? undefined : unescape(tag.slice(from, end));
};

/** A fired message's leading block, and the text after it; text without one comes back as it is. */
export const splitScheduleMark = (
  text: string
): { readonly mark?: ScheduleMarkInfo; readonly text: string } => {
  if (!text.startsWith(MARK_OPEN)) {
    return { text };
  }
  const tagEnd = text.indexOf(">\n");
  const close = text.indexOf(`\n${MARK_CLOSE}`);
  if (tagEnd === -1 || close === -1 || close < tagEnd) {
    return { text };
  }
  const tag = text.slice(0, tagEnd);
  const schedule = attribute(tag, "schedule");
  const title = attribute(tag, "title");
  const due = attribute(tag, "due");
  if (schedule === undefined || title === undefined || due === undefined) {
    return { text };
  }
  const rest = text.slice(close + MARK_CLOSE.length + 1);
  return {
    mark: { schedule, title, due },
    text: rest.startsWith("\n\n") ? rest.slice(2) : rest.trimStart(),
  };
};

/** `ms` in `zone`, short: `Wed, Nov 4, 09:00`. */
export const formatInZone = (ms: number, zone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const pad = (value: string) => value.padStart(2, "0");

/** A cron in words when it is one of the form's shapes; `undefined` for anything else. */
export const cronInWords = (cron: string): string | undefined => {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return undefined;
  }
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  if (!/^\d+$/u.test(minute) || !/^\d+$/u.test(hour)) {
    return undefined;
  }
  if (day !== "*" || month !== "*") {
    return undefined;
  }
  const at = `${pad(hour)}:${pad(minute)}`;
  if (weekday === "*") {
    return `Every day at ${at}`;
  }
  if (weekday === "1-5") {
    return `Weekdays at ${at}`;
  }
  if (/^[0-6]$/u.test(weekday)) {
    return `Every ${DAYS[Number(weekday)]} at ${at}`;
  }
  return undefined;
};

/** When a schedule fires, in words. */
export const describeWhen = (
  schedule: Pick<Schedule, "when" | "timeZone">
): string =>
  schedule.when.kind === "once"
    ? `Once, ${formatInZone(schedule.when.at, schedule.timeZone)}`
    : (cronInWords(schedule.when.cron) ?? `Cron ${schedule.when.cron}`);

/** The form's "how often". */
export type Repeat = "once" | "daily" | "weekdays" | "weekly" | "cron";

export interface WhenForm {
  readonly repeat: Repeat;
  /** `once`: a local date-time from a datetime-local input, `2026-11-04T09:00`. */
  readonly at: string;
  /** daily, weekdays, weekly: `09:00`. */
  readonly time: string;
  /** weekly: 0 (Sunday) to 6. */
  readonly weekday: number;
  readonly cron: string;
}

/** The form's choices as the API's `when`; `undefined` while incomplete. */
export const whenOf = (form: WhenForm): WhenInput | undefined => {
  if (form.repeat === "once") {
    return form.at === "" ? undefined : { at: form.at };
  }
  if (form.repeat === "cron") {
    return form.cron.trim() === "" ? undefined : { cron: form.cron.trim() };
  }
  const [hour = "", minute = ""] = form.time.split(":");
  if (!/^\d{1,2}$/u.test(hour) || !/^\d{2}$/u.test(minute)) {
    return undefined;
  }
  const hm = `${Number(minute)} ${Number(hour)}`;
  if (form.repeat === "daily") {
    return { cron: `${hm} * * *` };
  }
  if (form.repeat === "weekdays") {
    return { cron: `${hm} * * 1-5` };
  }
  return { cron: `${hm} * * ${form.weekday}` };
};

/** The line under a schedule: its next fire, a retry, or why it stopped. */
export const statusLine = (schedule: Schedule): string => {
  if (schedule.status === "cancelled") {
    return schedule.detail === undefined
      ? "Cancelled"
      : `Cancelled: ${schedule.detail}`;
  }
  if (schedule.status === "done") {
    return "Done";
  }
  if (schedule.status === "paused") {
    return "Paused";
  }
  if (schedule.retryAt !== undefined) {
    return `Waiting for room, try ${schedule.attempts + 1} at ${formatInZone(schedule.retryAt, schedule.timeZone)}`;
  }
  return schedule.nextAt === undefined
    ? "Active"
    : `Next: ${formatInZone(schedule.nextAt, schedule.timeZone)}`;
};

/** A run in a few words. */
export const runLabel = (run: ScheduleRun, zone: string): string => {
  const at = formatInZone(run.firedAt, zone);
  switch (run.status) {
    case "sent": {
      return `Sent ${at}${run.late ? " (late)" : ""}`;
    }
    case "missed": {
      return `Missed ${at}${run.detail === undefined ? "" : `: ${run.detail}`}`;
    }
    default: {
      return `Failed ${at}${run.detail === undefined ? "" : `: ${run.detail}`}`;
    }
  }
};

/** The browser's IANA zone, reported to the server so schedules use the person's wall clock. */
export const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};
