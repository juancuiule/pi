import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Agents } from "./agents/agents.ts";
import type { ConversationEvent } from "./conversation-events.ts";
import { Conversations } from "./server/conversations.ts";
import { fauxAgents } from "./testing/faux.ts";

const defaults = { idleTimeoutMs: 60_000, sweepEveryMs: 60_000 };

const firstOf = <E, R>(stream: Stream.Stream<ConversationEvent, E, R>) =>
  stream
    .pipe(Stream.take(1), Stream.runCollect)
    .pipe(Effect.map((chunk) => [...chunk][0]));

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 5000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error("waitUntil timed out"));
  });

/** Create a conversation and let its first prompt run to the end; its id plus its snapshot's entries. */
const ranConversation = Effect.gen(function* () {
  const conversations = yield* Conversations;
  const created = yield* conversations.create({
    sandbox: "none",
    prompt: "Say hi",
  });
  yield* waitUntil(
    conversations.list.pipe(Effect.map((all) => all[0]?.status === "idle"))
  );
  const snapshot = yield* conversations
    .events(created.id)
    .pipe(Effect.flatMap(firstOf));
  const entries = snapshot?.type === "snapshot" ? snapshot.entries : [];
  const assistant = entries.find(
    (each) => each.model?.[0]?.role === "assistant"
  );
  const user = entries.find((each) => each.model?.[0]?.role === "user");
  if (assistant === undefined || user === undefined) {
    return yield* Effect.die(new Error("the run left no transcript"));
  }
  return {
    id: created.id,
    assistant: Number(assistant.id),
    user: Number(user.id),
  };
});

const basic = `Basic ${Buffer.from("pk:sk").toString("base64")}`;

describe("feedback scores", () => {
  // A Langfuse stand-in: records every score POST it gets.
  const posts: {
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  let server: ReturnType<typeof createServer>;
  let port = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        posts.push({
          path: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    ({ port } = server.address() as AddressInfo);
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  const layer = (withLangfuse = true) => {
    const agents = fauxAgents([fauxAssistantMessage([fauxText("ok")])]);
    return Conversations.layer({
      ...defaults,
      ...(withLangfuse
        ? {
            langfuse: {
              baseUrl: `http://127.0.0.1:${port}`,
              publicKey: "pk",
              secretKey: "sk",
            },
          }
        : {}),
    }).pipe(Layer.provideMerge(agents.layer));
  };

  it("posts a score onto the run's trace, and upserts the same entry's next score", async () => {
    posts.length = 0;
    const { id, entry, traceId } = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const conversations = yield* Conversations;
        const ran = yield* ranConversation;
        const trace = yield* agents.entryTrace(
          ran.id as ConversationId,
          ran.assistant
        );
        yield* conversations.feedback(ran.id, {
          entry: ran.assistant,
          value: 1,
          comment: "good",
        });
        yield* conversations.feedback(ran.id, {
          entry: ran.assistant,
          value: 0,
        });
        return { id: ran.id, entry: ran.assistant, traceId: trace };
      }).pipe(Effect.provide(layer()))
    );

    expect(posts).toHaveLength(2);
    expect(posts[0]).toStrictEqual({
      path: "/api/public/scores",
      authorization: basic,
      body: {
        id: `effect-pi:feedback:${id}:${entry}`,
        traceId,
        name: "feedback",
        value: 1,
        dataType: "NUMERIC",
        comment: "good",
      },
    });
    // The second click upserts the same score id.
    expect(posts[1]).toStrictEqual({
      path: "/api/public/scores",
      authorization: basic,
      body: {
        id: `effect-pi:feedback:${id}:${entry}`,
        traceId,
        name: "feedback",
        value: 0,
        dataType: "NUMERIC",
      },
    });
  });

  it("posts a report as a score with the comment required", async () => {
    posts.length = 0;
    const { id, entry, traceId } = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const conversations = yield* Conversations;
        const ran = yield* ranConversation;
        const trace = yield* agents.entryTrace(
          ran.id as ConversationId,
          ran.assistant
        );
        yield* conversations.report(ran.id, {
          entry: ran.assistant,
          comment: "bad",
        });
        return { id: ran.id, entry: ran.assistant, traceId: trace };
      }).pipe(Effect.provide(layer()))
    );

    expect(posts).toStrictEqual([
      {
        path: "/api/public/scores",
        authorization: basic,
        body: {
          id: `effect-pi:report:${id}:${entry}`,
          traceId,
          name: "report",
          value: 1,
          dataType: "NUMERIC",
          comment: "bad",
        },
      },
    ]);
  });

  it("fails EntryNotFound for a missing entry and for a user's message", async () => {
    const { missing, user } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const ran = yield* ranConversation;
        return {
          missing: yield* Effect.exit(
            conversations.feedback(ran.id, { entry: 999_999, value: 1 })
          ),
          user: yield* Effect.exit(
            conversations.feedback(ran.id, { entry: ran.user, value: 1 })
          ),
        };
      }).pipe(Effect.provide(layer()))
    );

    expect(Exit.isFailure(missing)).toBeTruthy();
    expect(JSON.stringify(missing)).toContain("EntryNotFound");
    expect(Exit.isFailure(user)).toBeTruthy();
    expect(JSON.stringify(user)).toContain("EntryNotFound");
  });

  it("fails TraceUnavailable(disabled) when the server does not trace", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        return yield* conversations.feedback(1, { entry: 1, value: 1 });
      }).pipe(Effect.provide(layer(false)))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("TraceUnavailable");
    expect(JSON.stringify(exit)).toContain("disabled");
  });
});
