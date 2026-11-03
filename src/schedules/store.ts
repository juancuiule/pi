// Schedules, their recent runs and each User's time zone: three tables of their own in the EFFECT_PI_DB file, like
// `trusted_domains`. A schedule row keeps the columns the scheduler and the owner's lists query by (owner, target
// Conversation, status, the next wake) and the rest as JSON. Why SQLite and not pi-durable documents: ADR-0010.
import { DatabaseSync } from "node:sqlite";

import type { UserId } from "../auth/user.ts";
import type { Schedule, ScheduleRun } from "./format.ts";

/** Runs kept per schedule, newest first. */
const RUNS_KEPT = 20;

export interface ScheduleRecords {
  insert(schedule: Schedule): void;
  /** Replace a schedule's row; `false` when it is gone. */
  update(schedule: Schedule): boolean;
  get(id: string): Schedule | undefined;
  /** `owner`'s schedules, newest first; with `conversation`, only the follow-ups into it. */
  list(owner: UserId, conversation?: number): readonly Schedule[];
  countActive(owner: UserId): number;
  /** Active schedules whose next wake (a retry, else the occurrence) is at or before `now`. */
  due(now: number): readonly Schedule[];
  /** The earliest wake of any active schedule. */
  nextWake(): number | undefined;
  /** Record a run, keeping the newest few per schedule. */
  addRun(schedule: string, run: ScheduleRun): void;
  runs(schedule: string): readonly ScheduleRun[];
  timeZone(owner: UserId): string | undefined;
  setTimeZone(owner: UserId, zone: string, at: number): void;
}

interface Row {
  data: string;
}

const wakeOf = (schedule: Schedule) =>
  schedule.status === "active"
    ? (schedule.retryAt ?? schedule.nextAt ?? null)
    : null;

const parse = (row: Row) => JSON.parse(row.data) as Schedule;
const columns = (schedule: Schedule) => ({
  conversation:
    schedule.target.kind === "conversation"
      ? schedule.target.conversation
      : null,
  wake: wakeOf(schedule),
  data: JSON.stringify(schedule),
});
/** The tables in a SQLite file (`:memory:` for tests), created if missing. */
export const sqliteSchedules = (
  file: string
): ScheduleRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      conversation INTEGER,
      status TEXT NOT NULL,
      wake_at INTEGER,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_owner ON schedules (owner, created_at);
    CREATE INDEX IF NOT EXISTS schedules_wake ON schedules (wake_at) WHERE wake_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS schedule_runs (
      schedule TEXT NOT NULL,
      due INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (schedule, due)
    );
    CREATE TABLE IF NOT EXISTS time_zones (
      owner TEXT PRIMARY KEY,
      time_zone TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return {
    insert: (schedule) => {
      const { conversation, wake, data } = columns(schedule);
      db.prepare(
        "INSERT INTO schedules (id, owner, conversation, status, wake_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        schedule.id,
        schedule.owner,
        conversation,
        schedule.status,
        wake,
        schedule.createdAt,
        data
      );
    },
    update: (schedule) => {
      const { conversation, wake, data } = columns(schedule);
      return (
        db
          .prepare(
            "UPDATE schedules SET conversation = ?, status = ?, wake_at = ?, data = ? WHERE id = ?"
          )
          .run(conversation, schedule.status, wake, data, schedule.id).changes >
        0
      );
    },
    get: (id) => {
      const row = db
        .prepare("SELECT data FROM schedules WHERE id = ?")
        .get(id) as Row | undefined;
      return row === undefined ? undefined : parse(row);
    },
    list: (owner, conversation) =>
      (conversation === undefined
        ? (db
            .prepare(
              "SELECT data FROM schedules WHERE owner = ? ORDER BY created_at DESC, rowid DESC"
            )
            .all(owner) as unknown as Row[])
        : (db
            .prepare(
              "SELECT data FROM schedules WHERE owner = ? AND conversation = ? ORDER BY created_at DESC, rowid DESC"
            )
            .all(owner, conversation) as unknown as Row[])
      ).map(parse),
    countActive: (owner) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM schedules WHERE owner = ? AND status IN ('active', 'paused')"
          )
          .get(owner) as { n: number }
      ).n,
    due: (now) =>
      (
        db
          .prepare(
            "SELECT data FROM schedules WHERE wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at"
          )
          .all(now) as unknown as Row[]
      ).map(parse),
    nextWake: () =>
      (
        db
          .prepare(
            "SELECT MIN(wake_at) AS wake FROM schedules WHERE wake_at IS NOT NULL"
          )
          .get() as { wake: number | null }
      ).wake ?? undefined,
    addRun: (schedule, run) => {
      db.prepare(
        "INSERT OR REPLACE INTO schedule_runs (schedule, due, data) VALUES (?, ?, ?)"
      ).run(schedule, run.due, JSON.stringify(run));
      db.prepare(
        `DELETE FROM schedule_runs WHERE schedule = ? AND due NOT IN
           (SELECT due FROM schedule_runs WHERE schedule = ? ORDER BY due DESC LIMIT ?)`
      ).run(schedule, schedule, RUNS_KEPT);
    },
    runs: (schedule) =>
      (
        db
          .prepare(
            "SELECT data FROM schedule_runs WHERE schedule = ? ORDER BY due DESC"
          )
          .all(schedule) as unknown as Row[]
      ).map((row) => JSON.parse(row.data) as ScheduleRun),
    timeZone: (owner) =>
      (
        db
          .prepare("SELECT time_zone FROM time_zones WHERE owner = ?")
          .get(owner) as { time_zone: string } | undefined
      )?.time_zone,
    setTimeZone: (owner, zone, at) => {
      db.prepare(
        `INSERT INTO time_zones (owner, time_zone, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (owner) DO UPDATE SET time_zone = excluded.time_zone, updated_at = excluded.updated_at`
      ).run(owner, zone, at);
    },
    close: () => db.close(),
  };
};
