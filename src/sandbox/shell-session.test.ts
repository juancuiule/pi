// ShellSession tests over a fake SandboxShell: a Queue drives the PTY's output (shutdown ends it like an
// exit) and write/resize calls are recorded.
import { Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { SandboxShell } from "./sandbox.ts";
import { shellSession } from "./shell-session.ts";

const fakeShell = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Uint8Array>();
  const writes: Uint8Array[] = [];
  const sizes: { columns: number; rows: number }[] = [];
  const shell: SandboxShell = {
    output: Stream.fromQueue(queue),
    write: (bytes) =>
      Effect.sync(() => {
        writes.push(bytes);
      }),
    resize: (columns, rows) =>
      Effect.sync(() => {
        sizes.push({ columns, rows });
      }),
  };
  return { shell, queue, writes, sizes };
});

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (bytes_: Uint8Array) => new TextDecoder().decode(bytes_);

describe("a shell session", () => {
  it("replays scrollback to a new attach", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, queue } = yield* fakeShell;
          const session = yield* shellSession(shell);
          yield* Queue.offer(queue, bytes("before-attach"));
          // This attach consuming the frame proves the pump published it, so the next attach can
          // only get it from the replay buffer.
          yield* session.output.pipe(Stream.take(1), Stream.runCollect);
          const replayed = yield* session.output.pipe(
            Stream.take(1),
            Stream.runCollect
          );
          return replayed.map(text);
        })
      )
    );

    expect(result).toStrictEqual(["before-attach"]);
  });

  it("slices a large raw chunk into 4 KiB frames", async () => {
    const sizes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, queue } = yield* fakeShell;
          const session = yield* shellSession(shell);
          yield* Queue.offer(queue, new Uint8Array(4096 + 4096 + 808));
          const frames = yield* session.output.pipe(
            Stream.take(3),
            Stream.runCollect
          );
          return frames.map((frame) => frame.length);
        })
      )
    );

    expect(sizes).toStrictEqual([4096, 4096, 808]);
  });

  it("gives two attaches the replay and then the same live output", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, queue } = yield* fakeShell;
          const session = yield* shellSession(shell);
          yield* Queue.offer(queue, bytes("replayed"));
          // The first attach proves the pump caught up before the second subscribes.
          yield* session.output.pipe(Stream.take(1), Stream.runCollect);

          const a = yield* session.output.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild
          );
          const b = yield* session.output.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild
          );
          yield* Queue.offer(queue, bytes("live"));
          const aFrames = yield* Fiber.join(a);
          const bFrames = yield* Fiber.join(b);
          return [aFrames.map(text), bFrames.map(text)];
        })
      )
    );

    expect(result).toStrictEqual([
      ["replayed", "live"],
      ["replayed", "live"],
    ]);
  });

  it("bounds scrollback: frames past the window are evicted", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, queue } = yield* fakeShell;
          const session = yield* shellSession(shell, {
            scrollbackBytes: 2 * 4096,
          });
          yield* Queue.offerAll(queue, [
            bytes("evicted"),
            bytes("kept-1"),
            bytes("kept-2"),
          ]);
          // Waits for the last publish (a subscriber's deque is only as wide as the window, so it
          // cannot count three), proving the replay buffer holds kept-1 and kept-2.
          yield* session.output.pipe(
            Stream.filter((frame) => text(frame) === "kept-2"),
            Stream.take(1),
            Stream.runCollect
          );
          const replayed = yield* session.output.pipe(
            Stream.take(2),
            Stream.runCollect
          );
          return replayed.map(text);
        })
      )
    );

    expect(result).toStrictEqual(["kept-1", "kept-2"]);
  });

  it("goes dead when the PTY's output ends: alive flips, attaches end", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, queue } = yield* fakeShell;
          const session = yield* shellSession(shell);
          const attached = yield* session.output.pipe(
            Stream.runCollect,
            Effect.forkChild
          );
          yield* Queue.shutdown(queue);
          const ended = yield* Fiber.join(attached);
          const alive = yield* session.alive;
          const late = yield* session.output.pipe(
            Stream.take(1),
            Stream.runCollect
          );
          return { ended, alive, late };
        })
      )
    );

    expect(result.ended).toStrictEqual([]);
    expect(result.alive).toBeFalsy();
    expect(result.late).toStrictEqual([]);
  });

  it("goes dead when its scope closes", async () => {
    const alive = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* fakeShell.pipe(
          Effect.flatMap(({ shell }) => shellSession(shell)),
          Scope.provide(scope)
        );
        yield* Scope.close(scope, Exit.void);
        return yield* session.alive;
      })
    );

    expect(alive).toBeFalsy();
  });

  it("forwards write and resize to the wrapped shell", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { shell, writes, sizes } = yield* fakeShell;
          const session = yield* shellSession(shell);
          yield* session.write(bytes("stdin"));
          yield* session.resize(120, 40);
          return { writes: writes.map(text), sizes };
        })
      )
    );

    expect(result.writes).toStrictEqual(["stdin"]);
    expect(result.sizes).toStrictEqual([{ columns: 120, rows: 40 }]);
  });
});
