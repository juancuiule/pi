// The Scheduler end to end, on the faux model and TestClock: follow-ups, recurring new conversations, a full
// Capacity, catching up after downtime, a restart mid-fire, and the agent's `schedule` tool.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Search } from "../search/search.ts";
import { Conversations } from "../server/conversations.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { alice } from "../testing/users.ts";
import { MARK_OPEN } from "./format.ts";
import { Scheduler } from "./scheduler.ts";
import { Schedules } from "./schedules.ts";

const START = Date.parse("2026-11-03T08:00:00Z");
const MINUTE = 60_000;

/** A faux turn that records the last user message's text, then answers `reply`. */
const recording =
  (seen: string[], reply = "ok"): FauxResponseStep =>
  (request) => {
    const last = request.messages.findLast(
      (message) => message.role === "user"
    );
    const content = last?.content ?? "";
    seen.push(
      typeof content === "string"
        ? content
        : content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
    );
    return fauxAssistantMessage([fauxText(reply)]);
  };

const setup = (
  responses: FauxResponseStep[],
  options: {
    readonly seats?: number;
    readonly database?: string;
    readonly start?: number;
  } = {}
) => {
  const agents = fauxAgents(responses, {
    limits: { seats: options.seats ?? 10 },
    schedules: Schedules.local({ database: options.database ?? ":memory:" }),
  });
  const conversations = Conversations.layer({
    idleTimeoutMs: 24 * 60 * MINUTE,
    sweepEveryMs: 24 * 60 * MINUTE,
  }).pipe(Layer.provideMerge(Search.none), Layer.provideMerge(agents.layer));
  // Set before anything sleeps: TestClock wakes every sleeper on the way, so a jump from 1970 would step the
  // scheduler's capped sleeps through 56 years.
  const startAt = Layer.effectDiscard(
    TestClock.setTime(options.start ?? START)
  );
  return Scheduler.layer().pipe(
    Layer.provideMerge(conversations),
    Layer.provide(startAt),
    // Everything reads this clock, so the test moves time for the scheduler and the agents alike.
    Layer.provideMerge(TestClock.layer())
  );
};

/** Poll on the real clock: the agents' work is real async under the frozen test clock. */
const until = (check: Effect.Effect<boolean, unknown>, timeoutMs = 5000) =>
  TestClock.withLive(
    Effect.gen(function* () {
      for (let waited = 0; waited < timeoutMs; waited += 10) {
        if (yield* check) {
          return;
        }
        yield* Effect.sleep("10 millis");
      }
      return yield* Effect.die(new Error("timed out waiting"));
    })
  );

const run = <A, E>(
  layer: ReturnType<typeof setup>,
  program: Effect.Effect<A, E, Conversations | Schedules>
) => Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));

/** A Conversation of alice's whose first Run has ended. */
const conversation = (prompt = "hello") =>
  Effect.gen(function* () {
    const conversations = yield* Conversations;
    const created = yield* conversations.create({
      owner: alice.id,
      sandbox: "none",
      prompt,
    });
    yield* until(
      conversations
        .list(alice.id)
        .pipe(
          Effect.map((all) =>
            all.some((each) => each.id === created.id && each.status === "idle")
          )
        )
    );
    return created.id;
  });

describe("the scheduler", () => {
  it("sends a follow-up into its conversation at its time, re-seating a paused one, once", async () => {
    const seen: string[] = [];
    const result = await run(
      setup([recording(seen), recording(seen, "reminded")]),
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const schedules = yield* Schedules;
        const id = yield* conversation();
        const schedule = yield* schedules.create(alice.id, {
          title: "Stretch",
          prompt: "Remind me to stretch.",
          when: { inMinutes: 60 },
          target: { kind: "conversation", conversation: id },
          createdBy: "person",
        });
        yield* conversations.pause(id);
        yield* TestClock.adjust(59 * MINUTE);
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        const early = seen.length;
        yield* TestClock.adjust(2 * MINUTE);
        yield* until(Effect.sync(() => seen.length === 2));
        yield* until(
          schedules
            .get(alice.id, schedule.id)
            .pipe(Effect.map((each) => each.status === "done"))
        );
        const done = yield* schedules.get(alice.id, schedule.id);
        const runs = yield* schedules.runs(alice.id, schedule.id);
        // A one-time schedule is spent: an hour later nothing more fires.
        yield* TestClock.adjust(60 * MINUTE);
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        const summary = (yield* conversations.list(alice.id)).find(
          (each) => each.id === id
        );
        return { early, done, runs, summary, total: seen.length };
      })
    );
    const [, fired = ""] = seen;
    expect({
      early: result.early,
      total: result.total,
      marked: fired.startsWith(MARK_OPEN) && fired.includes('title="Stretch"'),
      message: fired.endsWith("Remind me to stretch."),
      nextAt: result.done.nextAt,
      last: result.done.lastRun?.status,
      paused: result.summary?.status === "paused",
    }).toStrictEqual({
      early: 1,
      total: 2,
      marked: true,
      message: true,
      nextAt: undefined,
      last: "sent",
      paused: false,
    });
    expect(result.runs).toMatchObject([
      { status: "sent", late: false, conversation: result.summary?.id },
    ]);
  });

  it("opens a new conversation per occurrence of a recurring schedule, titled and marked", async () => {
    const seen: string[] = [];
    const result = await run(
      setup([recording(seen, "report one"), recording(seen, "report two")]),
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const schedules = yield* Schedules;
        const schedule = yield* schedules.create(alice.id, {
          title: "Morning report",
          prompt: "Summarize the news.",
          when: { cron: "0 9 * * *" },
          timeZone: "UTC",
          target: {
            kind: "new",
            level: "none",
            software: [],
            approvals: "auto",
          },
          createdBy: "person",
        });
        yield* TestClock.adjust(61 * MINUTE);
        yield* until(Effect.sync(() => seen.length === 1));
        yield* TestClock.adjust(24 * 60 * MINUTE);
        yield* until(Effect.sync(() => seen.length === 2));
        yield* until(
          schedules
            .runs(alice.id, schedule.id)
            .pipe(Effect.map((runs) => runs.length === 2))
        );
        return {
          listed: yield* conversations.list(alice.id),
          after: yield* schedules.get(alice.id, schedule.id),
        };
      })
    );
    expect(result.listed.map((each) => each.title)).toStrictEqual([
      "Morning report",
      "Morning report",
    ]);
    expect(result.listed.map((each) => each.schedule?.due)).toStrictEqual([
      Date.parse("2026-11-04T09:00:00Z"),
      Date.parse("2026-11-03T09:00:00Z"),
    ]);
    expect(result.after.status).toBe("active");
    expect(result.after.nextAt).toBe(Date.parse("2026-11-05T09:00:00Z"));
    expect(seen.every((text) => text.startsWith(MARK_OPEN))).toBeTruthy();
  });

  it("retries a fire that finds no Seat, sends it late when room appears, and misses it after an hour", async () => {
    const seen: string[] = [];
    const result = await run(
      setup([recording(seen), recording(seen), recording(seen)], { seats: 1 }),
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const schedules = yield* Schedules;
        const holder = yield* conversation();
        const target = {
          kind: "new",
          level: "none",
          software: [],
          approvals: "auto",
        } as const;
        const late = yield* schedules.create(alice.id, {
          title: "Late",
          prompt: "late",
          when: { inMinutes: 10 },
          target,
          createdBy: "person",
        });
        yield* TestClock.adjust(10 * MINUTE);
        yield* until(
          schedules
            .get(alice.id, late.id)
            .pipe(Effect.map((each) => each.attempts === 1))
        );
        const waiting = yield* schedules.get(alice.id, late.id);
        // Room appears; the next try (1 minute later) goes through.
        yield* conversations.pause(holder);
        yield* TestClock.adjust(MINUTE);
        yield* until(
          schedules
            .get(alice.id, late.id)
            .pipe(Effect.map((each) => each.status === "done"))
        );
        const sent = yield* schedules.get(alice.id, late.id);
        // Now the server stays full for the whole retry window.
        const missed = yield* schedules.create(alice.id, {
          title: "Missed",
          prompt: "missed",
          when: { inMinutes: 5 },
          target,
          createdBy: "person",
        });
        for (let step = 0; step < 16; step += 1) {
          yield* TestClock.adjust(5 * MINUTE);
          yield* TestClock.withLive(Effect.sleep("20 millis"));
        }
        yield* until(
          schedules
            .get(alice.id, missed.id)
            .pipe(Effect.map((each) => each.status === "done"))
        );
        return {
          waiting,
          sent,
          missed: yield* schedules.get(alice.id, missed.id),
        };
      })
    );
    expect(result.waiting.retryAt).toBe(START + 11 * MINUTE);
    expect(result.sent.lastRun).toMatchObject({ status: "sent", late: true });
    expect(result.missed.lastRun?.status).toBe("missed");
    expect(result.missed.lastRun?.detail).toContain("seat limit (1)");
  });

  it("catches up once after downtime, and does not create twice an occurrence a restart interrupted", async () => {
    const database = path.join(
      mkdtempSync(path.join(tmpdir(), "schedules-")),
      "db.sqlite"
    );
    const created = await run(
      setup([], { database }),
      Effect.gen(function* () {
        const schedules = yield* Schedules;
        return yield* schedules.create(alice.id, {
          title: "Daily",
          prompt: "daily",
          when: { cron: "0 9 * * *" },
          timeZone: "UTC",
          target: {
            kind: "new",
            level: "none",
            software: [],
            approvals: "auto",
          },
          createdBy: "person",
        });
      })
    );
    // The server was down for three 9:00s; it comes back on day three at 10:00.
    const seen: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const schedules = yield* Schedules;
        const conversations = yield* Conversations;
        yield* until(Effect.sync(() => seen.length === 1));
        yield* until(
          schedules
            .get(alice.id, created.id)
            .pipe(Effect.map((each) => each.lastRun !== undefined))
        );
        const after = yield* schedules.get(alice.id, created.id);
        // A fire the last process started: its conversation exists, the row still says `firing`.
        const due = after.nextAt ?? 0;
        yield* conversations.create({
          owner: alice.id,
          sandbox: "none",
          prompt: "daily",
          title: "Daily",
          schedule: { id: created.id, title: "Daily", due, timeZone: "UTC" },
        });
        yield* schedules.save({ ...after, firing: due });
        yield* TestClock.setTime(due + MINUTE);
        yield* until(
          schedules
            .runs(alice.id, created.id)
            .pipe(Effect.map((runs) => runs.length === 2))
        );
        return {
          after,
          runs: yield* schedules.runs(alice.id, created.id),
          count: (yield* conversations.list(alice.id)).length,
        };
      }).pipe(
        Effect.provide(
          setup([recording(seen), recording(seen)], {
            database,
            start: Date.parse("2026-11-05T10:00:00Z"),
          })
        ),
        Effect.scoped
      )
    );
    expect(result.after.lastRun).toMatchObject({
      status: "sent",
      late: true,
      due: Date.parse("2026-11-03T09:00:00Z"),
    });
    expect(result.after.nextAt).toBe(Date.parse("2026-11-06T09:00:00Z"));
    expect(result.runs.map((each) => each.status)).toStrictEqual([
      "sent",
      "sent",
    ]);
    expect(result.count).toBe(2);
    expect(seen).toHaveLength(2);
  });
});

describe("the schedule tool", () => {
  it("schedules a follow-up the agent resolved, which then fires; list does not wait for approval under ask", async () => {
    const seen: string[] = [];
    const result = await run(
      setup([
        callTool("schedule", {
          action: "create",
          title: "Deploy check",
          prompt: "Check whether the deploy finished.",
          in_minutes: 30,
        }),
        echoToolResult,
        callTool("schedule", { action: "list" }),
        echoToolResult,
        recording(seen, "checked"),
      ]),
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const schedules = yield* Schedules;
        const id = yield* conversation("check the deploy in half an hour");
        const [made] = yield* schedules.list(alice.id);
        yield* conversations.configure(id, { approvals: "ask" });
        yield* conversations.send(id, "what is scheduled?");
        yield* until(
          conversations
            .list(alice.id)
            .pipe(
              Effect.map((all) => all.some((each) => each.status === "idle"))
            )
        );
        yield* TestClock.adjust(31 * MINUTE);
        yield* until(Effect.sync(() => seen.length === 1));
        return { made, id };
      })
    );
    expect(result.made).toMatchObject({
      title: "Deploy check",
      createdBy: "agent",
      origin: result.id,
      target: { kind: "conversation", conversation: result.id },
      nextAt: START + 30 * MINUTE,
    });
    expect(seen[0]).toContain("Check whether the deploy finished.");
  });

  it("waits for approval before the agent's create under ask, and keeps the conversation's machine and policy", async () => {
    const result = await run(
      setup([
        callTool("schedule", {
          action: "create",
          title: "Nightly",
          prompt: "Back up the notes.",
          where: "new_conversation",
          cron: "0 2 * * *",
        }),
        echoToolResult,
      ]),
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const schedules = yield* Schedules;
        const created = yield* conversations.create({
          owner: alice.id,
          sandbox: "none",
          prompt: "back up nightly",
          approvals: "ask",
        });
        yield* until(
          conversations
            .list(alice.id)
            .pipe(Effect.map((all) => all[0]?.pendingApprovals === 1))
        );
        const before = yield* schedules.list(alice.id);
        yield* conversations.decide(
          created.id,
          `${created.id}:call-schedule`,
          "approve"
        );
        yield* until(
          schedules.list(alice.id).pipe(Effect.map((all) => all.length === 1))
        );
        return { before, after: yield* schedules.list(alice.id) };
      })
    );
    expect(result.before).toHaveLength(0);
    expect(result.after[0]).toMatchObject({
      when: { kind: "cron", cron: "0 2 * * *" },
      timeZone: "UTC",
      target: { kind: "new", level: "none", approvals: "ask" },
    });
  });
});
