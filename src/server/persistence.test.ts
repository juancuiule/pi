// Persistent conversations: two Conversations+Agents layers over one SQLite file simulate a restart.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Context, Effect, Exit, Layer, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { AgentError } from "../agents/agents.ts";
import { Capacity } from "../capacity.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { Conversations } from "./conversations.ts";

const defaults = {
  idleTimeoutMs: 60_000,
  sweepEveryMs: 60_000,
};

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

/** Build the whole stack over a fresh storage on `dbFile`, run `program`, then tear it all down. */
const withStack = <A, E>(
  dbFile: string,
  responses: FauxResponseStep[],
  program: (
    conversations: (typeof Conversations)["Service"],
    faux: ReturnType<typeof fauxAgents>["faux"]
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: Partial<typeof defaults> = {}
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        openNodeSqliteStorage(dbFile)
      );
      const agents = fauxAgents(responses, { storage });
      const layer = Conversations.layer({ ...defaults, ...options }).pipe(
        Layer.provide(agents.layer),
        Layer.provide(Capacity.layer({ seats: 10, shells: 3, desktops: 1 }))
      );
      const context = yield* Layer.build(layer);
      const conversations = Context.get(context, Conversations);
      return yield* program(conversations, agents.faux);
    })
  );

/** Poll `check` until it returns true, failing after `timeoutMs`. */
const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 5000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

/** The text of the next assistant message the conversation produces, or fails after 10 seconds. */
const nextAnswer = (events: Stream.Stream<AgentEvent, AgentError>) =>
  events.pipe(
    Stream.filter((event) => event.type === "message_end"),
    Stream.map((event) =>
      event.type === "message_end"
        ? (event.entry.model ?? [])
            .flatMap((m) =>
              m.role === "assistant"
                ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
                : []
            )
            .join("")
        : ""
    ),
    Stream.filter((text) => text !== ""),
    Stream.runHead,
    Effect.timeout("10 seconds")
  );

const db = () =>
  path.join(
    mkdtempSync(path.join(tmpdir(), "effect-pi-test-")),
    "state.sqlite"
  );

describe("persistent conversations", () => {
  it("keeps a chat conversation paused and resumable across a restart", async () => {
    const file = db();
    let id = -1;
    await Effect.runPromise(
      withStack(file, [answer("hello")], (conversations) =>
        Effect.gen(function* () {
          const created = yield* conversations.create({
            sandbox: "none",
            prompt: "Say hi",
          });
          ({ id } = created);
          yield* waitUntil(
            conversations.list.pipe(
              Effect.map((all) => all[0]?.status === "idle")
            )
          );
        })
      )
    );

    await Effect.runPromise(
      withStack(file, [answer("still here")], (conversations) =>
        Effect.gen(function* () {
          const listed = yield* conversations.list;
          const found = listed.find((c) => c.id === id);
          expect(found?.status).toBe("paused");
          expect(found?.title).toBe("Say hi");
          // Attach before sending so the run's events are not missed.
          const stream = yield* conversations.events(id);
          yield* conversations.send(id, "again");
          const got = yield* Effect.exit(nextAnswer(stream));
          expect(Exit.isSuccess(got)).toBeTruthy();
          expect(
            got._tag === "Success" &&
              got.value._tag === "Some" &&
              got.value.value
          ).toBe("still here");
        })
      )
    );
  });

  it("resumes a shell conversation after a restart, with its Workspace's files", async () => {
    const file = db();
    let id = -1;
    await Effect.runPromise(
      withStack(
        file,
        [callTool("bash", { command: "echo kept > note.txt" }), echoToolResult],
        (conversations) =>
          Effect.gen(function* () {
            ({ id } = yield* conversations.create({
              sandbox: "shell",
              prompt: "leave a note",
            }));
            yield* waitUntil(
              conversations.list.pipe(
                Effect.map((all) => all[0]?.status === "idle")
              )
            );
          })
      )
    );

    const result = await Effect.runPromise(
      withStack(
        file,
        [callTool("bash", { command: "cat note.txt" }), echoToolResult],
        (conversations) =>
          Effect.gen(function* () {
            const found = (yield* conversations.list).find((c) => c.id === id);
            const stream = yield* conversations.events(id);
            yield* conversations.send(id, "read it");
            const got = yield* nextAnswer(stream);
            return { found, got };
          })
      )
    );

    expect(result.found?.status).toBe("paused");
    expect(result.found?.sandboxId).toBeUndefined();
    expect(result.got._tag === "Some" && result.got.value).toContain("kept");
  });

  it("keeps an archived conversation listed across a restart and refuses sends", async () => {
    const file = db();
    let id = -1;
    await Effect.runPromise(
      withStack(file, [answer("ok")], (conversations) =>
        Effect.gen(function* () {
          ({ id } = yield* conversations.create({
            sandbox: "none",
            prompt: "hi",
          }));
          yield* conversations.archive(id);
          // Archiving twice is a no-op.
          yield* conversations.archive(id);
        })
      )
    );

    const result = await Effect.runPromise(
      withStack(file, [], (conversations) =>
        Effect.gen(function* () {
          const listed = yield* conversations.list;
          const sendExit = yield* Effect.exit(conversations.send(id, "again"));
          return { listed, sendExit };
        })
      )
    );

    expect(result.listed[0]?.status).toBe("archived");
    expect(Exit.isFailure(result.sendExit)).toBeTruthy();
    expect(JSON.stringify(result.sendExit)).toContain("ConversationArchived");
  });

  it("sweeps idle chat and shell conversations to paused", async () => {
    const file = db();
    const listed = await Effect.runPromise(
      withStack(
        file,
        [answer("a"), answer("b")],
        (conversations) =>
          Effect.gen(function* () {
            yield* conversations.create({ sandbox: "none", prompt: "chat" });
            yield* conversations.create({ sandbox: "shell", prompt: "shell" });
            yield* waitUntil(
              conversations.list.pipe(
                Effect.map((all) => all.every((c) => c.status === "paused"))
              ),
              15_000
            );
            return yield* conversations.list;
          }),
        { idleTimeoutMs: 50, sweepEveryMs: 10 }
      )
    );

    expect(listed.map((c) => c.status)).toStrictEqual(["paused", "paused"]);
  }, 30_000);

  it("handles two sends racing to resume the same paused chat", async () => {
    const file = db();
    let id = -1;
    await Effect.runPromise(
      withStack(file, [answer("a")], (conversations) =>
        Effect.gen(function* () {
          ({ id } = yield* conversations.create({
            sandbox: "none",
            prompt: "hi",
          }));
        })
      )
    );

    const answers = await Effect.runPromise(
      withStack(file, [answer("one"), answer("two")], (conversations) =>
        Effect.gen(function* () {
          // Attach before the sends so neither run's events are missed.
          const stream = yield* conversations.events(id);
          const ref = yield* Ref.make<string[]>([]);
          const scope = yield* Scope.Scope;
          yield* Stream.runForEach(
            stream.pipe(Stream.filter((event) => event.type === "message_end")),
            (event) => {
              const text =
                event.type === "message_end"
                  ? (event.entry.model ?? [])
                      .flatMap((m) =>
                        m.role === "assistant"
                          ? m.content.flatMap((c) =>
                              c.type === "text" ? [c.text] : []
                            )
                          : []
                      )
                      .join("")
                  : "";
              return text === ""
                ? Effect.void
                : Ref.update(ref, (all) => [...all, text]);
            }
          ).pipe(Effect.forkIn(scope));
          yield* Effect.all(
            [conversations.send(id, "first"), conversations.send(id, "second")],
            { concurrency: "unbounded" }
          );
          yield* waitUntil(
            Ref.get(ref).pipe(Effect.map((all) => all.length === 2)),
            15_000
          );
          return yield* Ref.get(ref);
        })
      )
    );

    expect(answers.toSorted()).toStrictEqual(["one", "two"]);
  });

  it("aborts work that was in flight when the harness closed, on reopen", async () => {
    const file = db();
    let id = -1;
    // Close the whole stack while `sleep 5` is mid-run: the layer teardown closes the harness and its
    // storage. The closest a test gets to a crash — the conversation scope's finalizers do run, but the
    // in-flight tool's outcome may not settle, leaving work pending for reopen to find.
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Effect.promise(() =>
          openNodeSqliteStorage(file)
        );
        const agents = fauxAgents(
          [callTool("bash", { command: "sleep 5" }), echoToolResult],
          { storage }
        );
        const layer = Conversations.layer(defaults).pipe(
          Layer.provide(agents.layer),
          Layer.provide(Capacity.layer({ seats: 10, shells: 3, desktops: 1 }))
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer);
            const conversations = Context.get(context, Conversations);
            const created = yield* conversations.create({
              sandbox: "shell",
              prompt: "sleep",
            });
            ({ id } = created);
            yield* waitUntil(
              conversations.list.pipe(
                Effect.map((all) => all[0]?.status === "running")
              ),
              10_000
            );
          })
        );
      })
    );

    // Reopen: nothing may run, and no further model request is made.
    await Effect.runPromise(
      withStack(file, [], (conversations, faux) =>
        Effect.gen(function* () {
          const listed = yield* conversations.list;
          expect(listed.find((c) => c.id === id)?.status).toBe("paused");
          yield* Effect.sleep("300 millis");
          expect(faux.state.callCount).toBe(0);
        })
      )
    );
  }, 30_000);
});
