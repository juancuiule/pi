// A conversation's interactive shell, served as a WebSocket upgrade on
// `/api/conversations/:id/shell`: binary frames carry the PTY in both directions, a text frame
// `{"type":"resize","columns":n,"rows":n}` resizes it, and the server sends `{"type":"closed","reason":...}`
// before its CloseEvent when the shell exits or the Sandbox goes away. The upgrade request is an ordinary
// request first, so the `loopbackOnly` middleware merged into the same router answers 403 before this runs.
import { Deferred, Effect, Exit, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { Conversations } from "./conversations.ts";

/** The terminal size the console opens with, from `?cols=&rows=`; anything unusable falls back to 80x24. */
const sizeOf = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.url, "http://localhost");
  const columns = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));
  return {
    columns:
      Number.isInteger(columns) && columns > 0 && columns <= 500 ? columns : 80,
    rows: Number.isInteger(rows) && rows > 0 && rows <= 500 ? rows : 24,
  };
};

/** A client text frame is a control message; anything that is not `resize` is ignored. */
const resizeOf = (text: string) => {
  try {
    const message: unknown = JSON.parse(text);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "resize" &&
      "columns" in message &&
      typeof message.columns === "number" &&
      "rows" in message &&
      typeof message.rows === "number"
    ) {
      return { columns: message.columns, rows: message.rows };
    }
  } catch {
    // Not JSON: ignore.
  }
};

const session = Effect.gen(function* () {
  const conversations = yield* Conversations;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 0) {
    return HttpServerResponse.text("Unknown conversation", { status: 404 });
  }
  // A paused or archived Conversation has no Seat: nothing runs to shell into.
  const seat = yield* conversations.seat(id);
  if (seat === undefined) {
    return HttpServerResponse.text("The conversation has no live seat", {
      status: 404,
    });
  }

  const upgraded = yield* Effect.exit(request.upgrade);
  if (Exit.isFailure(upgraded)) {
    return HttpServerResponse.text("Not an upgrade request", { status: 400 });
  }
  const socket = upgraded.value;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const acquired = yield* Effect.exit(
        Effect.zip(socket.writer, socket.reader)
      );
      if (Exit.isFailure(acquired)) {
        return;
      }
      const [writer, reader] = acquired.value;
      const close = (reason: string) =>
        Effect.ignore(
          Effect.andThen(
            writer.write(JSON.stringify({ type: "closed", reason })),
            writer.write(new Socket.CloseEvent(1000, reason))
          )
        );

      // Level `none`, or a Sandbox mid-replacement: there is nothing to run a shell in.
      const opened = yield* Effect.exit(seat.shell(sizeOf(request)));
      if (Exit.isFailure(opened)) {
        yield* close("unavailable");
        return;
      }
      const shell = opened.value;
      const done = yield* Deferred.make<string>();
      const finish = (reason: string) =>
        Effect.ignore(Deferred.succeed(done, reason));
      const onEnd = (reason: string, label: string) =>
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.logWarning(`${label} ended early`, cause),
            finish(reason)
          )
        );

      // PTY → client; the stream ends when the shell exits.
      yield* Stream.runForEach(shell.output, (chunk) =>
        writer.write(chunk)
      ).pipe(
        onEnd("exited", "the sandbox shell's output"),
        Effect.andThen(finish("exited")),
        Effect.forkChild
      );

      // Sandbox replaced (Upgrade) or removed (Pause): the watch's first
      // emission is the current one, so every later one ends the session.
      const changes = yield* Effect.exit(seat.sandboxChanges);
      if (Exit.isFailure(changes)) {
        yield* close("unavailable");
        return;
      }
      yield* Stream.runForEach(Stream.drop(changes.value, 1), () =>
        finish("sandbox")
      ).pipe(
        onEnd("sandbox", "the sandbox watch"),
        Effect.andThen(finish("sandbox")),
        Effect.forkChild
      );

      // Client → PTY: binary frames are stdin, a text frame is a control
      // message. The reader ends when the client goes away.
      const read = reader.pull.pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(
            frames,
            (frame) => {
              if (typeof frame !== "string") {
                return shell.write(frame);
              }
              const resize = resizeOf(frame);
              return resize === undefined
                ? Effect.void
                : Effect.ignore(shell.resize(resize.columns, resize.rows));
            },
            { discard: true }
          )
        ),
        Effect.forever
      );
      yield* read.pipe(
        onEnd("disconnected", "the client socket"),
        Effect.andThen(finish("disconnected")),
        Effect.forkChild
      );

      yield* close(yield* Deferred.await(done));
    })
  );
  return HttpServerResponse.empty();
});

/** The shell's WebSocket route, merged into the router `apiLayer` serves. */
export const shellRoute = HttpRouter.add(
  "GET",
  "/api/conversations/:id/shell",
  session
);
