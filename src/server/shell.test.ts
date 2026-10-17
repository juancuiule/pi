// Route tests for the interactive shell's WebSocket. The local Sandboxes run bash under a real PTY
// (python3 pty.spawn), so echo, `exit` and disconnect behave like the Docker Sandboxes'; resize is a no-op there,
// so the control frame is only checked not to break the session.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer, Schedule } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type * as NetAddress from "effect/net/NetAddress";
import { describe, expect, it } from "vitest";

import { SkillSource } from "../skills/source.ts";
import { fauxAgents } from "../testing/faux.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { apiLayer } from "./handlers.ts";
import { shellRoute } from "./shell.ts";

const server = (responses: FauxResponseStep[]) =>
  HttpRouter.serve(
    Layer.mergeAll(apiLayer({ apiUrl: "http://127.0.0.1" }), shellRoute),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provide(fauxAgents(responses).layer),
    Layer.provide(SkillSource.memory({})),
    Layer.provideMerge(NodeHttpServer.layerTest)
  );

const ok = [fauxAssistantMessage([fauxText("ok")])];

const until = (f: () => boolean) =>
  Effect.suspend(() => (f() ? Effect.succeed(true) : Effect.fail(false))).pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
    Effect.orElseSucceed(() => false)
  );

interface TestSocket {
  output: string;
  readonly controls: { readonly type: string; readonly reason?: string }[];
  readonly done: Promise<{ readonly code: number }>;
  readonly send: (bytes: Uint8Array | string) => void;
  readonly close: () => void;
}

const open = (url: string) =>
  Effect.callback<TestSocket, Error>((resume) => {
    const ws = new NodeWS.WebSocket(url);
    const utf8 = new TextDecoder();
    const closed = Promise.withResolvers<{ code: number }>();
    const socket: TestSocket = {
      output: "",
      controls: [],
      done: closed.promise,
      send: (bytes) => ws.send(bytes),
      close: () => ws.close(),
    };
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        socket.output += utf8.decode(data, { stream: true });
      } else {
        socket.controls.push(JSON.parse(data.toString()) as { type: string });
      }
    });
    ws.on("close", (code: number) => closed.resolve({ code }));
    ws.on("open", () => resume(Effect.succeed(socket)));
    ws.on("error", (error: Error) => resume(Effect.fail(error)));
  });

const ascii = new TextEncoder();

const portOf = HttpServer.HttpServer.pipe(
  Effect.map((http) => (http.address as NetAddress.InetAddress).port)
);

const shellUrl = (port: number, id: number) =>
  `ws://127.0.0.1:${port}/api/conversations/${id}/shell?cols=80&rows=24`;

describe("the shell socket", () => {
  it("refuses a non-loopback origin", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const get = (origin: string) =>
          client
            .execute(
              HttpClientRequest.get("/api/conversations/1/shell").pipe(
                HttpClientRequest.setHeader("origin", origin)
              )
            )
            .pipe(Effect.map((response) => response.status));
        return [
          yield* get("https://evil.example"),
          yield* get("http://localhost:3001"),
        ];
      }).pipe(Effect.provide(server(ok)))
    );

    expect(statuses).toStrictEqual([403, 404]);
  });

  it("answers 404 for a conversation with no live seat", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const http = yield* HttpClient.HttpClient;
        const missing = yield* http
          .execute(HttpClientRequest.get("/api/conversations/999/shell"))
          .pipe(Effect.map((response) => response.status));
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "hi" },
        });
        // Level none has a Seat but no Sandbox; a paused Conversation has no Seat at all.
        yield* client.conversations.pause({ params: { id: created.id } });
        const paused = yield* http
          .execute(
            HttpClientRequest.get(`/api/conversations/${created.id}/shell`)
          )
          .pipe(Effect.map((response) => response.status));
        return [missing, paused];
      }).pipe(Effect.provide(server(ok)))
    );

    expect(statuses).toStrictEqual([404, 404]);
  });

  it("echoes typed input and reports the shell's exit", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        const port = yield* portOf;
        const socket = yield* open(shellUrl(port, created.id));
        socket.send(ascii.encode("echo MARKER\n"));
        const echoed = yield* until(() => socket.output.includes("MARKER"));
        socket.send(ascii.encode("exit\n"));
        const closed = yield* until(() =>
          socket.controls.some(
            (control) =>
              control.type === "closed" && control.reason === "exited"
          )
        );
        socket.close();
        return { echoed, closed };
      }).pipe(Effect.provide(server(ok)))
    );

    expect(result).toStrictEqual({ echoed: true, closed: true });
  });

  it("takes a resize control frame without breaking the session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        const port = yield* portOf;
        const socket = yield* open(shellUrl(port, created.id));
        socket.send(JSON.stringify({ type: "resize", columns: 100, rows: 50 }));
        socket.send(ascii.encode("echo AFTER-RESIZE\n"));
        const echoed = yield* until(() =>
          socket.output.includes("AFTER-RESIZE")
        );
        socket.close();
        return echoed;
      }).pipe(Effect.provide(server(ok)))
    );

    expect(result).toBeTruthy();
  });

  it("closes with a message when the conversation pauses", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        const port = yield* portOf;
        const socket = yield* open(shellUrl(port, created.id));
        yield* until(() => socket.output.length > 0);
        yield* client.conversations.pause({ params: { id: created.id } });
        const closed = yield* until(() =>
          socket.controls.some(
            (control) =>
              control.type === "closed" && control.reason === "sandbox"
          )
        );
        return closed;
      }).pipe(Effect.provide(server(ok)))
    );

    expect(result).toBeTruthy();
  });

  it("closes on upgrade and a reconnect lands in the new sandbox", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hi" },
        });
        const port = yield* portOf;
        const socket = yield* open(shellUrl(port, created.id));
        yield* until(() => socket.output.length > 0);
        yield* client.conversations.upgrade({
          params: { id: created.id },
          payload: { level: "desktop" },
        });
        const closed = yield* until(() =>
          socket.controls.some(
            (control) =>
              control.type === "closed" && control.reason === "sandbox"
          )
        );

        const reopened = yield* open(shellUrl(port, created.id));
        reopened.send(ascii.encode("echo NEW-SANDBOX\n"));
        const echoed = yield* until(() =>
          reopened.output.includes("NEW-SANDBOX")
        );
        reopened.close();
        return { closed, echoed };
      }).pipe(Effect.provide(server(ok)))
    );

    expect(result).toStrictEqual({ closed: true, echoed: true });
  });

  // Each failed `until` below waits up to ~10s, so a regression takes longer than the default 5s.
  describe("the shared shell session", { timeout: 30_000 }, () => {
    it("keeps the shell's state across a reconnect", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(Api);
          const created = yield* client.conversations.create({
            payload: { sandbox: "shell", prompt: "hi" },
          });
          const port = yield* portOf;
          const first = yield* open(shellUrl(port, created.id));
          first.send(ascii.encode("cd /tmp\n"));
          first.send(ascii.encode("echo MARKER-1\n"));
          const marked = yield* until(() => first.output.includes("MARKER-1"));
          first.close();

          const second = yield* open(shellUrl(port, created.id));
          const replayed = yield* until(() =>
            second.output.includes("MARKER-1")
          );
          second.send(ascii.encode("pwd\n"));
          const inTmp = yield* until(() =>
            second.output.split("\n").some((line) => line.trim() === "/tmp")
          );
          second.close();
          return { marked, replayed, inTmp };
        }).pipe(Effect.provide(server(ok)))
      );

      expect(result).toStrictEqual({
        marked: true,
        replayed: true,
        inTmp: true,
      });
    });

    it("two sockets share one shell", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(Api);
          const created = yield* client.conversations.create({
            payload: { sandbox: "shell", prompt: "hi" },
          });
          const port = yield* portOf;
          const first = yield* open(shellUrl(port, created.id));
          const second = yield* open(shellUrl(port, created.id));
          first.send(ascii.encode("echo SHARED\n"));
          const firstSaw = yield* until(() => first.output.includes("SHARED"));
          const secondSaw = yield* until(() =>
            second.output.includes("SHARED")
          );
          first.close();
          second.close();
          return { firstSaw, secondSaw };
        }).pipe(Effect.provide(server(ok)))
      );

      expect(result).toStrictEqual({ firstSaw: true, secondSaw: true });
    });

    it("an exited shell restarts on the next attach", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(Api);
          const created = yield* client.conversations.create({
            payload: { sandbox: "shell", prompt: "hi" },
          });
          const port = yield* portOf;
          const first = yield* open(shellUrl(port, created.id));
          first.send(ascii.encode("echo MARKER-1\n"));
          yield* until(() => first.output.includes("MARKER-1"));
          first.send(ascii.encode("exit\n"));
          const exited = yield* until(() =>
            first.controls.some(
              (control) =>
                control.type === "closed" && control.reason === "exited"
            )
          );

          const second = yield* open(shellUrl(port, created.id));
          second.send(ascii.encode("pwd\n"));
          const inWorkspace = yield* until(() =>
            second.output.includes("effect-pi-workspace-")
          );
          const fresh = !second.output.includes("MARKER-1");
          second.close();
          return { exited, inWorkspace, fresh };
        }).pipe(Effect.provide(server(ok)))
      );

      expect(result).toStrictEqual({
        exited: true,
        inWorkspace: true,
        fresh: true,
      });
    });
  });
});
