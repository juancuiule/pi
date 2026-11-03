import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  escapeScheduleTags,
  followingOccurrence,
  isScheduledRequest,
  nextCron,
  resolveWhen,
  retryDelay,
  scheduleBlock,
  scheduleRequestId,
  validZone,
} from "./format.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const NEW_YORK = "America/New_York";

const resolved = (input: Parameters<typeof resolveWhen>[0], zone = NEW_YORK) =>
  resolveWhen(input, zone, NOW);

describe(resolveWhen, () => {
  it("reads a bare date-time as the zone's wall clock", () => {
    const result = resolved({ at: "2026-11-04T09:00" });
    expect(Result.getOrThrow(result)).toStrictEqual({
      when: { kind: "once", at: Date.parse("2026-11-04T14:00:00Z") },
      nextAt: Date.parse("2026-11-04T14:00:00Z"),
    });
  });

  it("takes an ISO time with an offset as that instant, and minutes from now", () => {
    expect(
      Result.getOrThrow(resolved({ at: "2026-11-04T09:00:00-03:00" })).nextAt
    ).toBe(Date.parse("2026-11-04T12:00:00Z"));
    expect(Result.getOrThrow(resolved({ inMinutes: 60 })).nextAt).toBe(
      NOW + 3_600_000
    );
  });

  it("refuses the past, far-off times and unreadable ones with a sentence", () => {
    const past = resolved({ at: "2026-11-02T09:00" });
    expect(Result.isFailure(past) && past.failure.reason).toContain(
      "in the past"
    );
    expect(Result.isFailure(resolved({ at: "2028-01-01T09:00" }))).toBeTruthy();
    expect(Result.isFailure(resolved({ at: "tomorrow" }))).toBeTruthy();
    // Without an offset or Z, only the zone's local form is taken.
    expect(Result.isFailure(resolved({ at: "2026-11-04" }))).toBeTruthy();
    expect(Result.isFailure(resolved({ inMinutes: 0 }))).toBeTruthy();
  });

  it("takes a five-field cron in the zone, and refuses one more frequent than every 5 minutes", () => {
    const weekdays = Result.getOrThrow(resolved({ cron: "0 9 * * 1-5" }));
    // Tuesday noon UTC is 7:00 in New York: the next 9:00 is today's.
    expect(weekdays.nextAt).toBe(Date.parse("2026-11-03T14:00:00Z"));
    expect(
      [
        "* * * * *",
        "*/2 9 * * *",
        "0 0 9 * * *",
        "not a cron",
        "*/5 * * * *",
      ].map((cron) => Result.isSuccess(resolved({ cron })))
    ).toStrictEqual([false, false, false, false, true]);
  });

  it("follows daylight saving time in the zone", () => {
    // New York leaves DST on 2026-11-01: 9:00 is 13:00 UTC before, 14:00 after.
    const before = Date.parse("2026-10-30T00:00:00Z");
    expect(nextCron("0 9 * * *", NEW_YORK, before)).toBe(
      Date.parse("2026-10-30T13:00:00Z")
    );
    expect(nextCron("0 9 * * *", NEW_YORK, NOW)).toBe(
      Date.parse("2026-11-03T14:00:00Z")
    );
  });
});

describe(followingOccurrence, () => {
  it("skips the occurrences that passed while the server was down", () => {
    const daily = {
      when: { kind: "cron", cron: "0 9 * * *" },
      timeZone: "UTC",
    } as const;
    const due = Date.parse("2026-11-01T09:00:00Z");
    expect(followingOccurrence(daily, due, NOW)).toBe(
      Date.parse("2026-11-04T09:00:00Z")
    );
    expect(
      followingOccurrence(
        { when: { kind: "once", at: due }, timeZone: "UTC" },
        due,
        NOW
      )
    ).toBeUndefined();
  });
});

describe("the fired message", () => {
  it("leads with a block naming the schedule, which typed text cannot forge", () => {
    const block = scheduleBlock({
      id: "sch_1",
      title: 'Check "deploy" <now>',
      due: Date.parse("2026-11-04T14:00:00Z"),
      timeZone: NEW_YORK,
    });
    expect(block).toContain(
      '<scheduled_run schedule="sch_1" title="Check &quot;deploy&quot; &lt;now&gt;" due="2026-11-04T09:00:00.000-05:00">'
    );
    expect(block.endsWith("</scheduled_run>")).toBeTruthy();
    expect(escapeScheduleTags("<scheduled_run x>")).not.toContain(
      "<scheduled_run"
    );
  });

  it("names its submission so a re-fire is the same one, and notifications can tell", () => {
    const id = scheduleRequestId("sch_1", 5);
    expect(id).toBe("schedule:sch_1:5");
    expect(isScheduledRequest(id)).toBeTruthy();
    expect(isScheduledRequest("typed-1")).toBeFalsy();
    expect(isScheduledRequest()).toBeFalsy();
  });
});

describe("validZone and retryDelay", () => {
  it("keeps IANA names only", () => {
    expect(validZone("Europe/Madrid")).toBe("Europe/Madrid");
    expect(validZone("UTC")).toBe("UTC");
    expect(validZone("Mars/Base")).toBeUndefined();
    expect(validZone("+03:00")).toBeUndefined();
  });

  it("backs off 1, 2, 4, 8, then 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => retryDelay(n) / 60_000)).toStrictEqual(
      [1, 2, 4, 8, 15, 15]
    );
  });
});
