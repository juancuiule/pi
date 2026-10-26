// A conversation's interactive shell, served as a WebSocket upgrade on
// `/api/conversations/:id/shell`: binary frames carry the PTY in both directions, a text frame
// `{"type":"resize","columns":n,"rows":n}` resizes it, and the server sends `{"type":"closed","reason":...}`
// before its CloseEvent when the shell session ends or the Sandbox goes away. The PTY is a session owned by
// the Sandbox's lifetime (Seat.shell), so a socket dropping detaches this client without killing the shell —
// a reconnect lands back in it with scrollback replayed. The shell's `open` command, run while this socket is
// attached, sends `{"type":"open","path":"/workspace/...","kind":"file"|"directory"}`; a replay never does.
// It is outside the HttpApi, so it runs `seatForSocket` (src/server/seat-socket.ts) for `Authentication`'s checks:
// a session cookie (401 without one) and a Conversation of the caller's own (404 otherwise).
import { Deferred, Effect, Exit, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { seatForSocket } from "./seat-socket.ts";

const SHELL_ROUTE = "/api/conversations/:id/shell";

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

const resizeOf = (text: string) => {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
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
};

const session = Effect.gen(function* () {
  const found = yield* seatForSocket(SHELL_ROUTE);
  if (HttpServerResponse.isHttpServerResponse(found)) {
    return found;
  }
  const seat = found;
  const request = yield* HttpServerRequest.HttpServerRequest;

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
      const size = sizeOf(request);
      const opened = yield* Effect.exit(seat.shell(size));
      if (Exit.isFailure(opened)) {
        yield* close("unavailable");
        return;
      }
      const shell = opened.value;
      // The PTY is shared and seat-scoped, so a later attach adopts the newest client's size.
      yield* Effect.ignore(shell.resize(size.columns, size.rows));
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

      // PTY → client; the stream ends when the shell session ends, and `ended` says how: the shell
      // exiting is "exited", the Sandbox closing underneath it (Upgrade, Pause) is "sandbox". A doc
      // watch could not tell them apart — `exited` would race the change's delivery.
      yield* Stream.runForEach(shell.output, (chunk) =>
        writer.write(chunk)
      ).pipe(
        onEnd("exited", "the sandbox shell's output"),
        Effect.andThen(
          shell.ended.pipe(
            Effect.flatMap((end) =>
              finish(end === "close" ? "sandbox" : "exited")
            )
          )
        ),
        Effect.forkChild
      );
      yield* Stream.runForEach(shell.opens, (open) =>
        writer.write(JSON.stringify({ type: "open", ...open }))
      ).pipe(onEnd("exited", "the sandbox shell's opens"), Effect.forkChild);

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
      // message. The reader ends when the client goes away — that only ends this
      // client's view; the session keeps running for the next attach.
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
export const shellRoute = HttpRouter.add("GET", SHELL_ROUTE, session);
