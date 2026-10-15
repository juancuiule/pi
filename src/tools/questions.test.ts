// `ask_user`: the call waits for answers whatever the approval policy, and the model reads each answer next to its
// question; a skip, a Stop and the approval decisions behave as documented in src/tools/questions.ts.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Effect, Exit, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { ApprovalPolicy } from "../approvals.ts";
import { approvalKey, STOPPED } from "../approvals.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  openSeat,
} from "../testing/faux.ts";
import { answersText, SKIPPED } from "./questions.ts";
import type { Question } from "./questions.ts";

const database: Question = {
  id: "db",
  question: "Which database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
};
const features: Question = {
  id: "features",
  question: "Which features?",
  options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
  multiple: true,
};

describe(answersText, () => {
  it("puts each answer next to its question and lists the open ones", () => {
    expect(
      JSON.parse(
        answersText(
          [database, features],
          [{ id: "db", selected: ["SQLite"], other: "" }]
        )
      )
    ).toStrictEqual({
      answers: [{ question: "Which database?", selected: ["SQLite"] }],
      unanswered: ["Which features?"],
    });
  });

  it("keeps several options for a multiple-choice question and one otherwise", () => {
    expect(
      JSON.parse(
        answersText(
          [database, features],
          [
            { id: "db", selected: ["SQLite", "Postgres"] },
            { id: "features", selected: ["Auth", "Search"] },
          ]
        )
      )
    ).toStrictEqual({
      answers: [
        { question: "Which database?", selected: ["SQLite"] },
        { question: "Which features?", selected: ["Auth", "Search"] },
      ],
    });
  });

  it("drops labels that are not options, and keeps the person's own text", () => {
    expect(
      JSON.parse(
        answersText(
          [database],
          [{ id: "db", selected: ["MySQL"], other: "  DuckDB  " }]
        )
      )
    ).toStrictEqual({
      answers: [{ question: "Which database?", selected: [], other: "DuckDB" }],
    });
  });
});

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

/** Open a Seat, send a prompt whose answer calls `ask_user`, and collect the events while the call waits. */
const asking = (approvals: ApprovalPolicy = "auto") =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const conversation = yield* openSeat({ approvals });
    const ref = yield* Ref.make<AgentEvent[]>([]);
    const events = yield* agents.events(conversation.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    yield* conversation.send("plan the app");
    yield* waitUntil(
      conversation.pendingApprovals.pipe(Effect.map((count) => count === 1))
    );
    return {
      conversation,
      ref,
      key: approvalKey(conversation.id, "call-ask_user"),
    };
  });

const result = (ref: Ref.Ref<AgentEvent[]>) =>
  waitUntil(
    Ref.get(ref).pipe(
      Effect.map((all) => all.some((event) => event.type === "run_end"))
    )
  ).pipe(
    Effect.andThen(Ref.get(ref)),
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "tool_execution_end" && event.entry !== undefined
          ? (event.entry.model ?? []).flatMap((m) =>
              m.role === "toolResult" ? [m] : []
            )
          : []
      )
    ),
    Effect.map((results) => results[0])
  );

const textOf = (
  message: { content: readonly { type: string }[] } | undefined
) =>
  (message?.content ?? [])
    .flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : []))
    .join("");

const askUser = callTool("ask_user", { questions: [database, features] });

describe("ask_user", () => {
  it("waits under the auto policy and returns the answers", async () => {
    const { layer } = fauxAgents([askUser, echoToolResult]);
    const text = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref, key } = yield* asking("auto");
          yield* conversation.answer(key, [
            { id: "db", selected: ["Postgres"] },
            { id: "features", selected: ["Auth", "Billing"], other: "Exports" },
          ]);
          const message = yield* result(ref);
          expect(message?.isError).toBeFalsy();
          expect(message?.details).toMatchObject({ approval: "answered" });
          expect(yield* conversation.pendingApprovals).toBe(0);
          return textOf(message);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(JSON.parse(text)).toStrictEqual({
      answers: [
        { question: "Which database?", selected: ["Postgres"] },
        {
          question: "Which features?",
          selected: ["Auth", "Billing"],
          other: "Exports",
        },
      ],
    });
  });

  it("tells the model the questions were skipped", async () => {
    const { layer } = fauxAgents([askUser, echoToolResult]);
    const message = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref, key } = yield* asking();
          yield* conversation.answer(key);
          return yield* result(ref);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(message?.isError).toBeFalsy();
    expect(textOf(message)).toBe(SKIPPED);
  });

  it("is not decided by approval choices, and answer refuses unknown or gated keys", async () => {
    const { layer } = fauxAgents([askUser, echoToolResult]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, key } = yield* asking("ask");
          const decided = yield* Effect.exit(
            conversation.decide(key, "always")
          );
          expect(JSON.stringify(decided)).toContain("ApprovalNotFound");
          const unknown = yield* Effect.exit(conversation.answer("1:nope"));
          expect(Exit.isFailure(unknown)).toBeTruthy();
          expect(yield* conversation.pendingApprovals).toBe(1);
          yield* conversation.answer(key, [{ id: "db", selected: ["SQLite"] }]);
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("ends with the Stop reason when the person stops the Run", async () => {
    const { layer } = fauxAgents([askUser, echoToolResult]);
    const message = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* asking();
          yield* conversation.stop;
          return yield* result(ref);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(message?.isError).toBeTruthy();
    expect(textOf(message)).toContain(STOPPED);
  });
});
