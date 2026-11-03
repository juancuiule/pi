import type { Schedule } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  cronInWords,
  describeWhen,
  splitScheduleMark,
  statusLine,
  whenOf,
} from "./schedules";

const BLOCK = [
  '<scheduled_run schedule="sch_1" title="Check &quot;deploy&quot;" due="2026-11-04T09:00:00.000-05:00">',
  "A schedule sent this message at its due time; the person did not type it just now. Do what it asks, then answer as usual.",
  "</scheduled_run>",
].join("\n");

describe(splitScheduleMark, () => {
  it("reads the block a fired message leads with", () => {
    expect(splitScheduleMark(`${BLOCK}\n\nIs it done?`)).toStrictEqual({
      mark: {
        schedule: "sch_1",
        title: 'Check "deploy"',
        due: "2026-11-04T09:00:00.000-05:00",
      },
      text: "Is it done?",
    });
  });

  it("leaves other text alone", () => {
    expect(splitScheduleMark("hello")).toStrictEqual({ text: "hello" });
    expect(splitScheduleMark("<scheduled_run broken")).toStrictEqual({
      text: "<scheduled_run broken",
    });
  });
});

describe(whenOf, () => {
  const form = {
    repeat: "daily",
    at: "",
    time: "09:30",
    weekday: 1,
    cron: "",
  } as const;

  it("turns the form's shapes into crons, and a date-time into `at`", () => {
    expect([
      whenOf(form),
      whenOf({ ...form, repeat: "weekdays" }),
      whenOf({ ...form, repeat: "weekly" }),
      whenOf({ ...form, repeat: "once", at: "2026-11-04T09:00" }),
      whenOf({ ...form, repeat: "cron", cron: " 0 */2 * * * " }),
    ]).toStrictEqual([
      { cron: "30 9 * * *" },
      { cron: "30 9 * * 1-5" },
      { cron: "30 9 * * 1" },
      { at: "2026-11-04T09:00" },
      { cron: "0 */2 * * *" },
    ]);
    expect(whenOf({ ...form, repeat: "once" })).toBeUndefined();
  });

  it("says the form's crons back in words", () => {
    expect(
      ["30 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 */2 * * *"].map(cronInWords)
    ).toStrictEqual([
      "Every day at 09:30",
      "Weekdays at 09:00",
      "Every Monday at 09:00",
      undefined,
    ]);
  });
});

describe(statusLine, () => {
  const schedule: Schedule = {
    id: "sch_1",
    title: "t",
    prompt: "p",
    when: { kind: "once", at: Date.parse("2026-11-04T14:00:00Z") },
    timeZone: "America/New_York",
    target: { kind: "conversation", conversation: 1 },
    status: "active",
    nextAt: Date.parse("2026-11-04T14:00:00Z"),
    attempts: 0,
    createdAt: 0,
    createdBy: "person",
  };

  it("shows the next fire in the schedule's zone, a retry, or why it ended", () => {
    expect(describeWhen(schedule)).toBe("Once, Wed, Nov 4, 09:00");
    expect([
      statusLine(schedule),
      statusLine({
        ...schedule,
        retryAt: Date.parse("2026-11-04T14:01:00Z"),
        attempts: 1,
      }),
      statusLine({
        ...schedule,
        status: "cancelled",
        detail: "Its conversation was archived.",
      }),
    ]).toStrictEqual([
      "Next: Wed, Nov 4, 09:00",
      "Waiting for room, try 2 at Wed, Nov 4, 09:01",
      "Cancelled: Its conversation was archived.",
    ]);
  });
});
