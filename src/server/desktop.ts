// A conversation's desktop, served as a WebSocket upgrade on `/api/conversations/:id/desktop`: the server relays
// frames both ways between the console's noVNC client and the Sandbox's websockify (`SandboxInfo.vncUrl`), which
// carries the RFB protocol of the desktop's VNC server. Only the stream crosses; the console bundles its own noVNC,
// so nothing the Sandbox serves ever runs in the console's origin. The relay ends when either side closes or the
// Sandbox is replaced (Upgrade) or removed (Pause); noVNC then shows itself disconnected and the panel reconnects.
// It is outside the HttpApi, so it runs `seatForSocket` for the session and ownership checks, like the shell.
import { Deferred, Effect, Exit, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { seatForSocket } from "./seat-socket.ts";

const DESKTOP_ROUTE = "/api/conversations/:id/desktop";

/** Copy every frame `from` pulls into `to` until `from` ends or fails. */
const pump = (
  from: Socket.Reader,
  to: (frame: Uint8Array | string) => Effect.Effect<void, Socket.SocketError>
) =>
  from.pull.pipe(
    Effect.flatMap((frames) => Effect.forEach(frames, to, { discard: true })),
    Effect.forever
  );

const relay = Effect.gen(function* () {
  const found = yield* seatForSocket(DESKTOP_ROUTE);
  if (HttpServerResponse.isHttpServerResponse(found)) {
    return found;
  }
  const seat = found;
  const target = seat.sandbox?.vncUrl;
  if (target === undefined) {
    return HttpServerResponse.text("The sandbox has no desktop", {
      status: 404,
    });
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const upgraded = yield* Effect.exit(request.upgrade);
  if (Exit.isFailure(upgraded)) {
    return HttpServerResponse.text("Not an upgrade request", { status: 400 });
  }
  const client = upgraded.value;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const clientEnds = yield* Effect.exit(
        Effect.zip(client.writer, client.reader)
      );
      if (Exit.isFailure(clientEnds)) {
        return;
      }
      const [toClient, fromClient] = clientEnds.value;
      const close = (reason: string) =>
        Effect.ignore(toClient.write(new Socket.CloseEvent(1000, reason)));

      const upstream = yield* Socket.makeWebSocket(target, {
        openTimeout: "10 seconds",
      }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
      const upstreamEnds = yield* Effect.exit(
        Effect.zip(upstream.writer, upstream.reader)
      );
      if (Exit.isFailure(upstreamEnds)) {
        yield* Effect.logWarning(
          "the sandbox desktop did not answer",
          upstreamEnds.cause
        );
        yield* close("unavailable");
        return;
      }
      const [toUpstream, fromUpstream] = upstreamEnds.value;

      const done = yield* Deferred.make<string>();
      const finish = (reason: string) =>
        Effect.ignore(Deferred.succeed(done, reason));

      yield* pump(fromUpstream, toClient.write).pipe(
        Effect.exit,
        Effect.andThen(finish("sandbox")),
        Effect.forkChild
      );
      yield* pump(fromClient, toUpstream.write).pipe(
        Effect.exit,
        Effect.andThen(finish("disconnected")),
        Effect.forkChild
      );
      // The watch's first emission is the current Sandbox, so any later one means it was replaced or removed.
      const changes = yield* Effect.exit(seat.sandboxChanges);
      if (Exit.isFailure(changes)) {
        yield* close("unavailable");
        return;
      }
      yield* Stream.runForEach(Stream.drop(changes.value, 1), () =>
        finish("sandbox")
      ).pipe(Effect.exit, Effect.andThen(finish("sandbox")), Effect.forkChild);

      yield* close(yield* Deferred.await(done));
    })
  );
  return HttpServerResponse.empty();
});

/** The desktop's WebSocket route, merged into the router `apiLayer` serves. */
export const desktopRoute = HttpRouter.add("GET", DESKTOP_ROUTE, relay);
