// `Seat.send` while a run waits on a person (an approval or `ask_user` card) steers that same run; sent while the
// run works it stays a follow-up, placed once the run ends.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  FauxResponseStep,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ApprovalPolicy } from "../approvals.ts";
import { approvalKey } from "../approvals.ts";
import { Attachments } from "../attachments/attachments.ts";
import type { ConversationEvent } from "../conversation-events.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  openSeat,
} from "../testing/faux.ts";
import type { Question } from "../tools/questions.ts";
import { Agents } from "./agents.ts";

const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

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

/** Open a Seat and collect its events into a Ref while it runs. */
const watching = (
  options: {
    readonly sandbox?: SandboxChoice;
    readonly approvals?: ApprovalPolicy;
  } = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const conversation = yield* openSeat(options);
    const ref = yield* Ref.make<ConversationEvent[]>([]);
    const events = yield* agents.events(conversation.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    return { conversation, ref };
  });

/** A step that records the request's messages, then answers with `answer`. */
const recording =
  (
    seen: TranscriptContext["messages"][],
    answer: FauxResponseStep
  ): FauxResponseStep =>
  (request, ...rest) => {
    seen.push(request.messages);
    return typeof answer === "function" ? answer(request, ...rest) : answer;
  };

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? [String((block as { text: unknown }).text)]
        : []
    )
    .join("");
};

/** The recorded request has a user message with `text` after its last tool result. */
const steeredAfterToolResult = (
  messages: TranscriptContext["messages"],
  text: string
) => {
  const toolIndex = messages.findLastIndex(
    (message) => message.role === "toolResult"
  );
  const userIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" && textOf(message.content).includes(text)
  );
  return toolIndex !== -1 && userIndex > toolIndex;
};

const count = (ref: Ref.Ref<ConversationEvent[]>, type: string) =>
  Ref.get(ref).pipe(
    Effect.map((all) => all.filter((event) => event.type === type).length)
  );

const hasRunEnd = (ref: Ref.Ref<ConversationEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => all.some((event) => event.type === "run_end"))
  );

const pendingOne = (seat: {
  readonly pendingApprovals: Effect.Effect<number, unknown>;
}) => seat.pendingApprovals.pipe(Effect.map((total) => total === 1));

/** Upload a file to the conversation, as the console's composer does. */
const upload = (name: string, contents: string, conversationId: number) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(path.join(tmpdir(), "upload-"));
    const file = path.join(dir, "file");
    writeFileSync(file, contents);
    const attachments = yield* Attachments;
    // The upload keeps a copy; the temporary file goes, as a request's does.
    return yield* attachments
      .upload({ path: file, name, contentType: "", conversationId })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
        )
      );
  });

const question: Question = {
  id: "db",
  question: "Which database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
};

describe("send while a run is busy", () => {
  it("steers the same run while a permission card waits", async () => {
    const seen: TranscriptContext["messages"][] = [];
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      recording(seen, reply("done")),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("run true");
          yield* waitUntil(pendingOne(conversation));
          const sent = yield* conversation.send("steer me");
          expect(sent.status).toBe("queued");
          yield* conversation.decide(
            approvalKey(conversation.id, "call-bash"),
            "approve"
          );
          yield* waitUntil(hasRunEnd(ref));
          // One run: the message joined it at the post-tools boundary, a new turn, not a new run.
          expect(yield* count(ref, "run_start")).toBe(1);
          expect(yield* count(ref, "turn_start")).toBe(2);
          expect(
            steeredAfterToolResult(seen.at(-1) ?? [], "steer me")
          ).toBeTruthy();
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("steers the same run while an ask_user card waits", async () => {
    const seen: TranscriptContext["messages"][] = [];
    const { layer } = fauxAgents([
      callTool("ask_user", { questions: [question] }),
      recording(seen, echoToolResult),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({ approvals: "auto" });
          yield* conversation.send("plan the app");
          yield* waitUntil(pendingOne(conversation));
          yield* conversation.send("steer the plan");
          yield* conversation.answer(
            approvalKey(conversation.id, "call-ask_user"),
            [{ id: "db", selected: ["SQLite"] }]
          );
          yield* waitUntil(hasRunEnd(ref));
          expect(yield* count(ref, "run_start")).toBe(1);
          expect(
            steeredAfterToolResult(seen.at(-1) ?? [], "steer the plan")
          ).toBeTruthy();
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("stays a follow-up while the run works, starting the next run with it", async () => {
    const seen: TranscriptContext["messages"][] = [];
    // A generation request held open, so the run is observably working when the send lands.
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const gated: FauxResponseStep = async (request) => {
      seen.push(request.messages);
      entered.resolve(true);
      await release.promise;
      return reply("first run done");
    };
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      gated,
      recording(seen, reply("second run done")),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("work");
          yield* waitUntil(pendingOne(conversation));
          yield* conversation.decide(
            approvalKey(conversation.id, "call-bash"),
            "approve"
          );
          // The approval is decided and its tool done: the run is generating the next turn.
          yield* Effect.promise(() => entered.promise);
          const sent = yield* conversation.send("while working");
          expect(sent.status).toBe("queued");
          release.resolve(true);
          yield* waitUntil(
            count(ref, "run_end").pipe(Effect.map((total) => total === 2))
          );
          const starts = yield* Ref.get(ref).pipe(
            Effect.map((all) =>
              all.filter((event) => event.type === "run_start")
            )
          );
          expect(starts).toHaveLength(2);
          expect(starts[1]?.inputs).toContain(sent.id);
          // The turn that was generating never saw it; the next run's request carries it.
          const first = seen[0] ?? [];
          const second = seen[1] ?? [];
          expect(
            first.some(
              (message) =>
                message.role === "user" &&
                textOf(message.content).includes("while working")
            )
          ).toBeFalsy();
          expect(
            textOf(
              second.findLast((message) => message.role === "user")?.content
            )
          ).toContain("while working");
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("steers the same run when the card is then denied", async () => {
    const seen: TranscriptContext["messages"][] = [];
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      recording(seen, echoToolResult),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("run true");
          yield* waitUntil(pendingOne(conversation));
          yield* conversation.send("steer me anyway");
          yield* conversation.decide(
            approvalKey(conversation.id, "call-bash"),
            "deny"
          );
          yield* waitUntil(hasRunEnd(ref));
          expect(yield* count(ref, "run_start")).toBe(1);
          const messages = seen.at(-1) ?? [];
          expect(
            steeredAfterToolResult(messages, "steer me anyway")
          ).toBeTruthy();
          const result = messages.findLast(
            (message) => message.role === "toolResult"
          );
          expect(
            result && "isError" in result ? result.isError : false
          ).toBeTruthy();
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("lets a queued steer die with the run on stop", async () => {
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      recording([], echoToolResult),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("run true");
          yield* waitUntil(pendingOne(conversation));
          const sent = yield* conversation.send("never mind");
          expect(sent.status).toBe("queued");
          yield* conversation.stop;
          yield* waitUntil(
            Ref.get(ref).pipe(
              Effect.map((all) =>
                all.some(
                  (event) =>
                    event.type === "submission" &&
                    event.record.id === sent.id &&
                    event.record.status === "unanswered"
                )
              )
            )
          );
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("withdraws a queued follow-up before the run picks it up", async () => {
    const seen: TranscriptContext["messages"][] = [];
    // Generation held open, so the run is observably working while the send queues behind it.
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const gated: FauxResponseStep = async () => {
      entered.resolve(true);
      await release.promise;
      return reply("done");
    };
    const { layer } = fauxAgents([gated, recording(seen, reply("next"))]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const { conversation, ref } = yield* watching();
          const first = yield* conversation.send("work");
          yield* Effect.promise(() => entered.promise);
          const sent = yield* conversation.send("never mind");
          // The queue the stream reports carries the input's text, so a client can show the bubble.
          yield* waitUntil(
            Ref.get(ref).pipe(
              Effect.map((all) =>
                all.some(
                  (event) =>
                    event.type === "inbox_update" &&
                    event.items.some((item) => item.id === sent.id)
                )
              )
            )
          );
          const items = (yield* Ref.get(ref)).findLast(
            (event) => event.type === "inbox_update"
          );
          expect(
            items?.type === "inbox_update" ? items.items : []
          ).toStrictEqual([
            { id: sent.id, mode: "followUp", text: "never mind" },
          ]);

          // Withdrawn: it settles unanswered and leaves the inbox. A repeat reports it settled; the first
          // send is already placed — too late to withdraw.
          expect([
            yield* agents.withdraw(conversation.id, sent.id),
            yield* agents.withdraw(conversation.id, sent.id),
            yield* agents.withdraw(conversation.id, first.id),
          ]).toStrictEqual(["withdrawn", "settled", "placed"]);
          const missing = yield* Effect.flip(
            agents.withdraw(conversation.id, 999_999)
          );
          expect(missing).toMatchObject({ _tag: "SubmissionNotFound" });

          // The run ends with the input gone: nothing ever queued behind it for the model to see.
          release.resolve(true);
          yield* waitUntil(hasRunEnd(ref));
          expect(yield* count(ref, "run_start")).toBe(1);
          expect(
            seen.some((messages) =>
              messages.some(
                (message) =>
                  message.role === "user" &&
                  textOf(message.content).includes("never mind")
              )
            )
          ).toBeFalsy();
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("admits a retried requestId once while parked", async () => {
    const seen: TranscriptContext["messages"][] = [];
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      recording(seen, reply("done")),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("run true");
          yield* waitUntil(pendingOne(conversation));
          const first = yield* conversation.send("steer once", [], "req-1");
          const second = yield* conversation.send("steer once", [], "req-1");
          expect(second.id).toBe(first.id);
          // One queued inbox item, carrying the steer mode.
          yield* waitUntil(
            Ref.get(ref).pipe(
              Effect.map((all) =>
                all.some(
                  (event) =>
                    event.type === "inbox_update" &&
                    event.items.some((item) => item.id === first.id)
                )
              )
            )
          );
          const items = (yield* Ref.get(ref)).findLast(
            (event) => event.type === "inbox_update"
          );
          expect(
            items?.type === "inbox_update"
              ? items.items.map((item) => item.id)
              : []
          ).toStrictEqual([first.id]);
          yield* conversation.decide(
            approvalKey(conversation.id, "call-bash"),
            "approve"
          );
          yield* waitUntil(hasRunEnd(ref));
          const placed = (seen.at(-1) ?? []).filter(
            (message) =>
              message.role === "user" &&
              textOf(message.content).includes("steer once")
          );
          expect(placed).toHaveLength(1);
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("steers a message carrying an attachment", async () => {
    const seen: TranscriptContext["messages"][] = [];
    const { layer } = fauxAgents([
      callTool("bash", { command: "true" }),
      recording(seen, reply("done")),
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* watching({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* conversation.send("run true");
          yield* waitUntil(pendingOne(conversation));
          const info = yield* upload(
            "notes.md",
            "Ship on Friday.",
            Number(conversation.id)
          );
          yield* conversation.send("steer me", [info.id]);
          yield* conversation.decide(
            approvalKey(conversation.id, "call-bash"),
            "approve"
          );
          yield* waitUntil(hasRunEnd(ref));
          expect(yield* count(ref, "run_start")).toBe(1);
          const placed = (seen.at(-1) ?? []).findLast(
            (message) => message.role === "user"
          );
          const text = textOf(placed?.content);
          expect(text).toContain("steer me");
          expect(text).toContain("<attachment ");
          expect(text).toContain("Ship on Friday.");
        })
      ).pipe(Effect.provide(layer))
    );
  });
});
