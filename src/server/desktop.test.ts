// Route tests for the desktop's WebSocket relay. A WebSocket server on a random port stands in for the Sandbox's
// websockify: it greets like a VNC server and echoes what it gets, so both directions of the relay are checked.
import type { AddressInfo } from "node:net";

import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type * as NetAddress from "effect/net/NetAddress";
import { describe, expect, it } from "vitest";

import { Auth } from "../auth/auth.ts";
import { Search } from "../search/search.ts";
import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import { SessionCookie, signedIn } from "../testing/auth.ts";
import { fauxAgents } from "../testing/faux.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { desktopRoute } from "./desktop.ts";
import { apiLayer } from "./handlers.ts";

const GREETING = "RFB 003.008\n";

/** A stand-in websockify: greets each connection, echoes its frames back prefixed, and can drop everyone. */
const fakeWebsockify = Effect.acquireRelease(
  Effect.callback<NodeWS.WebSocketServer>((resume) => {
    const wss = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws) => {
      ws.send(Buffer.from(GREETING));
      ws.on("message", (data: Buffer) =>
        ws.send(Buffer.concat([Buffer.from("echo:"), data]))
      );
    });
    wss.on("listening", () => resume(Effect.succeed(wss)));
  }),
  (wss) =>
    Effect.sync(() => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
    })
);

const server = (vncUrl: string) =>
  HttpRouter.serve(
    Layer.mergeAll(
      apiLayer({ apiUrl: "http://127.0.0.1", tracing: false }),
      desktopRoute
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provide(Search.none),
    Layer.provide(
      fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
        sandboxes: localSandboxes({ vncUrl }),
      }).layer
    ),
    Layer.provide(Skills.layer.pipe(Layer.provide(SkillSource.memory({})))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Auth.temporary()),
    (served) => signedIn().pipe(Layer.provideMerge(served))
  );

const until = (f: () => boolean) =>
  Effect.suspend(() => (f() ? Effect.succeed(true) : Effect.fail(false))).pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
    Effect.orElseSucceed(() => false)
  );

interface TestSocket {
  received: string;
  closed: boolean;
  readonly status: number;
  readonly send: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

/** A browser stand-in on `/desktop`: what it received, whether it was closed, or the refusal's status. */
const connect = (id: number) =>
  Effect.gen(function* () {
    const { port } = (yield* HttpServer.HttpServer)
      .address as NetAddress.InetAddress;
    const cookie = yield* SessionCookie;
    return yield* Effect.callback<TestSocket>((resume) => {
      const ws = new NodeWS.WebSocket(
        `ws://127.0.0.1:${port}/api/conversations/${id}/desktop`,
        cookie === undefined ? {} : { headers: { cookie } }
      );
      const socket: TestSocket = {
        received: "",
        closed: false,
        status: 101,
        send: (bytes) => ws.send(bytes),
        close: () => ws.close(),
      };
      ws.on("message", (data: Buffer) => {
        socket.received += data.toString();
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

describe("the desktop socket", () => {
  it("relays the VNC stream both ways, and closes when the desktop does", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const websockify = yield* fakeWebsockify;
          const { port } = websockify.address() as AddressInfo;
          return yield* Effect.gen(function* () {
            const client = yield* HttpApiClient.make(Api);
            const created = yield* client.conversations.create({
              payload: { sandbox: "desktop", prompt: "hi" },
            });
            const summary = (yield* client.conversations.list()).find(
              (each) => each.id === created.id
            );
            const socket = yield* connect(created.id);
            const greeted = yield* until(() =>
              socket.received.includes(GREETING)
            );
            socket.send(new TextEncoder().encode("key-event"));
            const echoed = yield* until(() =>
              socket.received.includes("echo:key-event")
            );
            for (const each of websockify.clients) {
              each.close();
            }
            const closed = yield* until(() => socket.closed);
            return { desktop: summary?.desktop, greeted, echoed, closed };
          }).pipe(Effect.provide(server(`ws://127.0.0.1:${port}/websockify`)));
        })
      )
    );

    expect(result).toStrictEqual({
      desktop: true,
      greeted: true,
      echoed: true,
      closed: true,
    });
  });

  it("answers 404 for a sandbox without a desktop", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        return (yield* connect(created.id)).status;
      }).pipe(Effect.provide(server("ws://127.0.0.1:1/websockify")))
    );

    expect(status).toBe(404);
  });
});
