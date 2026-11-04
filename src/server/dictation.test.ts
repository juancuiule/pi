// Route tests for the dictation socket, with a fake Transcriber: no real speech-to-text runs in `pnpm test`. The route
// sits outside the HttpApi and outside `conversations/:id`, so isolation.test.ts does not cover it: the 401 without a
// session is checked here by hand.
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer, Option, Schedule } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type * as NetAddress from "effect/net/NetAddress";
import { describe, expect, it } from "vitest";

import { Auth } from "../auth/auth.ts";
import type { DictationServerMessage } from "../dictation/protocol.ts";
import { Transcriber } from "../dictation/transcriber.ts";
import { Search } from "../search/search.ts";
import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import { SessionCookie, signedIn } from "../testing/auth.ts";
import { framesOf, silence, speech } from "../testing/dictation.ts";
import { fauxAgents } from "../testing/faux.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { dictationRoute } from "./dictation.ts";
import { apiLayer } from "./handlers.ts";

const server = (options: {
  readonly transcriber?: Layer.Layer<Transcriber>;
  readonly signIn?: boolean;
}) =>
  HttpRouter.serve(
    Layer.mergeAll(
      apiLayer({
        apiUrl: "http://127.0.0.1",
        tracing: false,
        dictation: options.transcriber !== undefined,
      }),
      dictationRoute({ interimMs: 0, pauseMs: 400, maxSeconds: 60 })
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(options.transcriber ?? Layer.empty),
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provide(Search.none),
    Layer.provide(fauxAgents([fauxAssistantMessage([fauxText("ok")])]).layer),
    Layer.provide(Skills.layer.pipe(Layer.provide(SkillSource.memory({})))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Auth.temporary()),
    (served) =>
      options.signIn === false
        ? served
        : signedIn().pipe(Layer.provideMerge(served))
  );

const until = (f: () => boolean) =>
  Effect.suspend(() => (f() ? Effect.succeed(true) : Effect.fail(false))).pipe(
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 200 }),
    Effect.orElseSucceed(() => false)
  );

interface TestSocket {
  readonly received: DictationServerMessage[];
  closed: boolean;
  readonly status: number;
  readonly send: (frame: string | Uint8Array) => void;
}

/** A browser stand-in on `/api/dictation`: the messages it got, whether it closed, or the refusal's status. */
const connect = Effect.gen(function* () {
  const { port } = (yield* HttpServer.HttpServer)
    .address as NetAddress.InetAddress;
  const cookie = Option.getOrUndefined(
    yield* Effect.serviceOption(SessionCookie)
  );
  return yield* Effect.callback<TestSocket>((resume) => {
    const ws = new NodeWS.WebSocket(
      `ws://127.0.0.1:${port}/api/dictation`,
      cookie === undefined ? {} : { headers: { cookie } }
    );
    const socket: TestSocket = {
      received: [],
      closed: false,
      status: 101,
      send: (frame) => ws.send(frame),
    };
    ws.on("message", (data: Buffer) => {
      socket.received.push(JSON.parse(data.toString()));
    });
    ws.on("close", () => {
      socket.closed = true;
    });
    ws.on("open", () => resume(Effect.succeed(socket)));
    ws.on("unexpected-response", (_request, response) => {
      ws.on("error", () => {});
      ws.terminate();
      resume(Effect.succeed({ ...socket, status: response.statusCode ?? 0 }));
    });
  });
});

const spoken = () => {
  const parts = [speech(600), silence(600), speech(600), silence(600)];
  const all = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

describe("the dictation socket", () => {
  it("streams final text for each spoken segment, then done, then closes", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(Api);
          const info = yield* client.info.get();
          const socket = yield* connect;
          socket.send(JSON.stringify({ type: "start", language: "es" }));
          for (const frame of framesOf(spoken())) {
            socket.send(frame);
          }
          socket.send(JSON.stringify({ type: "stop" }));
          const closed = yield* until(() => socket.closed);
          return {
            dictation: info.dictation,
            received: socket.received,
            closed,
          };
        }).pipe(
          Effect.provide(
            server({
              transcriber: Transcriber.fake(() => {
                calls += 1;
                return `parte ${calls}`;
              }),
            })
          )
        )
      )
    );

    expect(result).toStrictEqual({
      dictation: true,
      received: [
        { type: "ready", maxSeconds: 60, interim: false },
        { type: "final", segment: 0, text: "parte 1" },
        { type: "final", segment: 1, text: "parte 2" },
        { type: "done" },
      ],
      closed: true,
    });
  });

  it("answers 401 without a session", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* connect;
          return socket.status;
        }).pipe(
          Effect.provide(
            server({ transcriber: Transcriber.fake(() => ""), signIn: false })
          )
        )
      )
    );
    expect(status).toBe(401);
  });

  it("answers 404, and /api/info says dictation is off, without a transcriber", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(Api);
          const info = yield* client.info.get();
          const socket = yield* connect;
          return { dictation: info.dictation, status: socket.status };
        }).pipe(Effect.provide(server({})))
      )
    );
    expect(result).toStrictEqual({ dictation: false, status: 404 });
  });

  it("refuses a first frame that is not start", async () => {
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* connect;
          socket.send(framesOf(speech(100))[0] ?? new Uint8Array(2));
          yield* until(() => socket.closed);
          return socket.received;
        }).pipe(
          Effect.provide(server({ transcriber: Transcriber.fake(() => "") }))
        )
      )
    );
    expect(received).toStrictEqual([
      {
        type: "error",
        reason: "protocol",
        message: "The first frame must be a start message",
      },
    ]);
  });

  it("drops everything on cancel: no final, no done", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* connect;
          socket.send(JSON.stringify({ type: "start", language: null }));
          for (const frame of framesOf(spoken())) {
            socket.send(frame);
          }
          socket.send(JSON.stringify({ type: "cancel" }));
          const closed = yield* until(() => socket.closed);
          const types = socket.received.map((message) => message.type);
          return { types, closed };
        }).pipe(
          Effect.provide(
            server({
              // Never answers: only a cancel ends this session.
              transcriber: Transcriber.fake(() => Effect.never),
            })
          )
        )
      )
    );
    expect(result).toStrictEqual({ types: ["ready"], closed: true });
  });
});
