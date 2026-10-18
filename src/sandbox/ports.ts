// Publishing a sandbox's loopback port on the host's: a TCP listener on 127.0.0.1 whose every accepted
// socket is piped both ways into a channel the backend opens per connection. Raw bytes pass through, so
// HTTP, WebSocket upgrades and anything else reach the in-sandbox service unparsed.
import net from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { Effect } from "effect";
import type { Scope } from "effect";

import { SandboxError } from "./sandbox.ts";

export const listen = (
  connect: (port: number) => Effect.Effect<Duplex, SandboxError>,
  port: number
): Effect.Effect<{ readonly hostPort: number }, SandboxError, Scope.Scope> =>
  Effect.gen(function* () {
    const sockets = new Set<Socket>();
    const channels = new Set<Duplex>();
    const server = net.createServer();
    yield* Effect.acquireRelease(
      Effect.callback<Server, SandboxError>((resume) => {
        const onError = (cause: Error) =>
          resume(
            Effect.fail(
              new SandboxError({ message: "the port listener failed", cause })
            )
          );
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          // A runtime listener error (fd pressure) must not throw with no handler: the exposure
          // degrades but the process stays up.
          server.on("error", (cause) =>
            Effect.runFork(
              Effect.logWarning("an exposed port's listener errored", cause)
            )
          );
          resume(Effect.succeed(server));
        });
        // Interrupted before 'listening': the bound socket must not outlive the acquisition.
        return Effect.sync(() => {
          server.removeListener("error", onError);
          if (server.listening) {
            server.close();
          } else {
            server.once("listening", () => server.close());
          }
        });
      }),
      () =>
        Effect.sync(() => {
          server.close();
          for (const socket of sockets) {
            socket.destroy();
          }
          for (const channel of channels) {
            channel.destroy();
          }
          sockets.clear();
          channels.clear();
        })
    );
    server.on("connection", async (socket) => {
      sockets.add(socket);
      let channel: Duplex | undefined;
      const drop = () => {
        sockets.delete(socket);
        if (channel !== undefined) {
          channels.delete(channel);
        }
        socket.destroy();
        channel?.destroy();
      };
      // Attached before the channel opens: a client error while `connect` is in flight must not
      // throw with no listener.
      socket.once("close", drop);
      socket.once("error", drop);
      try {
        channel = await Effect.runPromise(connect(port));
      } catch {
        drop();
        return;
      }
      // The client may have hung up while the channel was opening.
      if (socket.destroyed) {
        channel.destroy();
        return;
      }
      channels.add(channel);
      channel.once("close", drop);
      // Half-close is normal for a TCP pipe: the service can end output while the client still sends, and a
      // Duplex.from channel reports that as ERR_STREAM_PREMATURE_CLOSE, not a real failure.
      channel.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          drop();
        }
      });
      socket.pipe(channel);
      channel.pipe(socket);
    });
    return { hostPort: (server.address() as AddressInfo).port };
  });
