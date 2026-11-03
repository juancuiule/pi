// Calendar events in and out of iCalendar for the Nextcloud tools. Reads come from a CalDAV query with `expand`, so
// recurring events arrive as their instances with UTC times; writes create plain single events. Dates the model
// gives are ISO 8601, with an offset for timed events or a bare date for all-day ones.
import { randomUUID } from "node:crypto";

import {
  escapeText,
  parseComponents,
  property,
  serialize,
  textValue,
} from "./lines.ts";
import type { Component } from "./lines.ts";

export interface CalendarEvent {
  readonly uid: string;
  readonly summary: string;
  /** ISO 8601: `2026-11-03T10:00:00Z`, `2026-11-03` for an all-day event, or a local time with its zone. */
  readonly start: string;
  readonly end?: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly description?: string;
  /** Set on an instance of a recurring event. */
  readonly recurring: boolean;
  readonly status?: string;
}

const DATE = /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/u;
const DATE_TIME =
  /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})T(?<h>\d{2})(?<min>\d{2})(?<s>\d{2})(?<z>Z?)$/u;

/** An iCalendar DATE or DATE-TIME as ISO 8601; a zoned local time keeps its TZID in brackets. */
export const isoOf = (
  value: string,
  tzid: string | undefined
): { readonly iso: string; readonly allDay: boolean } | undefined => {
  const date = DATE.exec(value)?.groups;
  if (date !== undefined) {
    return { iso: `${date.y}-${date.m}-${date.d}`, allDay: true };
  }
  const time = DATE_TIME.exec(value)?.groups;
  if (time === undefined) {
    return undefined;
  }
  const local = `${time.y}-${time.m}-${time.d}T${time.h}:${time.min}:${time.s}`;
  if (time.z === "Z") {
    return { iso: `${local}Z`, allDay: false };
  }
  return {
    iso: tzid === undefined ? local : `${local} [${tzid}]`,
    allDay: false,
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

// An all-day event's DTEND is exclusive (the day after its last); the tools speak of the last day itself.
const inclusiveEnd = (
  end: { readonly iso: string; readonly allDay: boolean } | undefined
) =>
  end?.allDay === true
    ? {
        iso: new Date(new Date(`${end.iso}T00:00:00Z`).getTime() - DAY_MS)
          .toISOString()
          .slice(0, 10),
        allDay: true,
      }
    : end;

const eventOf = (event: Component): CalendarEvent | undefined => {
  const start = property(event, "DTSTART");
  const parsed =
    start === undefined
      ? undefined
      : isoOf(start.value.trim(), start.params.TZID);
  if (parsed === undefined) {
    return undefined;
  }
  const endProp = property(event, "DTEND");
  const end =
    endProp === undefined
      ? undefined
      : inclusiveEnd(isoOf(endProp.value.trim(), endProp.params.TZID));
  const location = textValue(event, "LOCATION");
  const description = textValue(event, "DESCRIPTION");
  const status = textValue(event, "STATUS");
  return {
    uid: textValue(event, "UID") ?? "",
    summary: textValue(event, "SUMMARY") ?? "(no title)",
    start: parsed.iso,
    ...(end === undefined ? {} : { end: end.iso }),
    allDay: parsed.allDay,
    ...(location === undefined ? {} : { location }),
    ...(description === undefined ? {} : { description }),
    recurring:
      property(event, "RECURRENCE-ID") !== undefined ||
      property(event, "RRULE") !== undefined,
    ...(status === undefined ? {} : { status }),
  };
};

/** The VEVENTs of one calendar object. */
export const parseEvents = (ics: string): CalendarEvent[] =>
  parseComponents(ics)
    .filter((component) => component.name === "VCALENDAR")
    .flatMap((calendar) =>
      calendar.components.filter((component) => component.name === "VEVENT")
    )
    .flatMap((event) => {
      const parsed = eventOf(event);
      return parsed === undefined ? [] : [parsed];
    });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

const basicUtc = (date: Date): string =>
  `${date.toISOString().slice(0, 19).replaceAll(/[-:]/gu, "")}Z`;

/** An ISO 8601 date or date-time as iCalendar's, or a message saying what is wrong with it. */
export const icalTime = (
  value: string,
  what: string
):
  | { readonly allDay: boolean; readonly value: string; readonly date: Date }
  | { readonly error: string } => {
  const trimmed = value.trim();
  if (ISO_DATE.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(date.getTime())
      ? { error: `${what} is not a date: ${value}` }
      : { allDay: true, value: trimmed.replaceAll("-", ""), date };
  }
  if (!HAS_OFFSET.test(trimmed)) {
    return {
      error: `${what} needs a UTC offset (2026-11-03T10:00:00-03:00) or Z, or a bare date for an all-day event: ${value}`,
    };
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime())
    ? { error: `${what} is not an ISO 8601 date-time: ${value}` }
    : { allDay: false, value: basicUtc(date), date };
};

/** iCalendar's UTC DATE-TIME form, for CalDAV time-range filters. */
export const utcStamp = basicUtc;

export interface NewEvent {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
}

/** A single-event calendar object, or a message saying which field is wrong. */
export const buildEvent = (
  input: NewEvent,
  now: Date = new Date()
):
  | { readonly uid: string; readonly ics: string }
  | { readonly error: string } => {
  const start = icalTime(input.start, "start");
  if ("error" in start) {
    return start;
  }
  const end = icalTime(input.end, "end");
  if ("error" in end) {
    return end;
  }
  if (start.allDay !== end.allDay) {
    return {
      error: "start and end must both be dates (all day) or both date-times.",
    };
  }
  if (end.date.getTime() < start.date.getTime()) {
    return { error: "end is before start." };
  }
  const uid = randomUUID();
  const dateParam = start.allDay ? ";VALUE=DATE" : "";
  // An all-day event's DTEND is exclusive: the day after its last day.
  const endValue = start.allDay
    ? new Date(end.date.getTime() + DAY_MS)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "")
    : end.value;
  return {
    uid,
    ics: serialize([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//effect-pi//Nextcloud connector//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${basicUtc(now)}`,
      `DTSTART${dateParam}:${start.value}`,
      `DTEND${dateParam}:${endValue}`,
      `SUMMARY:${escapeText(input.summary)}`,
      ...(input.location === undefined || input.location === ""
        ? []
        : [`LOCATION:${escapeText(input.location)}`]),
      ...(input.description === undefined || input.description === ""
        ? []
        : [`DESCRIPTION:${escapeText(input.description)}`]),
      "END:VEVENT",
      "END:VCALENDAR",
    ]),
  };
};
