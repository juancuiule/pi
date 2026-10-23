// A ShellSession multiplexes one scope-bound `SandboxShell` into attachable views: the raw `shell` contract
// stays "the exec dies with the scope", while each run of the session's `output` replays recent scrollback
// and then follows live, so a client that reconnects lands back in the same shell. `alive` reports the PTY's
// end so the owner can start a fresh session.
import { Cause, Deferred, Effect, PubSub, Ref, Stream } from "effect";
import type { Scope } from "effect";

import { OPEN_SCAN_START, scanOpens } from "./open-sequence.ts";
import type { WorkspaceOpen } from "./open-sequence.ts";
import type { SandboxShell } from "./sandbox.ts";

/** Bytes of PTY scrollback a new attach replays, kept as 4 KiB frames in a sliding PubSub. */
export const SHELL_SCROLLBACK_BYTES = 256 * 1024;

const FRAME_BYTES = 4 * 1024;

const framesOf = function* (chunk: Uint8Array) {
  for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
    yield chunk.subarray(offset, offset + FRAME_BYTES);
  }
};

/**
 * ShellSession IS a `SandboxShell`: `output` is the attach point (each run replays then follows live),
 * `write` and `resize` forward to the wrapped shell.
 */
export interface ShellSession extends SandboxShell {
  /** False once the PTY's output ended (exit or stream failure); the owner replaces the session then. */
  readonly alive: Effect.Effect<boolean>;
  /**
   * How the session ended, once it has: `exit` is the PTY's output ending, `close` is the session's
   * scope closing — the callers that map each to a protocol reason cannot tell them apart by timing.
   */
  readonly ended: Effect.Effect<"exit" | "close">;
  /**
   * The shell's `open` commands printed after a run subscribes. Never replayed, so a reattach cannot
   * fire an old one; `output` still carries their bytes, live and on replay, and the terminal swallows them.
   */
  readonly opens: Stream.Stream<WorkspaceOpen>;
}

/**
 * Multiplex a scope-bound `SandboxShell` so sockets can attach and detach freely. The pump fiber drains
 * `shell.output` into a sliding PubSub — sliding, not bounded, so a wedged consumer never stalls the PTY
 * for other viewers — and `finish` (running false, PubSub shutdown, `gone` completed) runs on stream end,
 * stream failure, and scope close alike.
 */
export const shellSession = (
  shell: SandboxShell,
  options?: { readonly scrollbackBytes?: number }
): Effect.Effect<ShellSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scrollbackBytes = options?.scrollbackBytes ?? SHELL_SCROLLBACK_BYTES;
    const replay = Math.ceil(scrollbackBytes / FRAME_BYTES);
    const pubsub = yield* PubSub.sliding<Uint8Array>({
      capacity: replay,
      replay,
    });
    const opens = yield* PubSub.sliding<WorkspaceOpen>(16);
    const running = yield* Ref.make(true);
    const gone = yield* Deferred.make<"exit" | "close">();

    const finish = (cause: "exit" | "close") =>
      Effect.andThen(
        Ref.set(running, false),
        Effect.andThen(
          Effect.andThen(PubSub.shutdown(pubsub), PubSub.shutdown(opens)),
          Effect.ignore(Deferred.succeed(gone, cause))
        )
      );

    yield* shell.output.pipe(
      Stream.mapAccum(
        () => OPEN_SCAN_START,
        (scan, chunk) => {
          const [next, found] = scanOpens(scan, chunk);
          return [next, [{ chunk, found }]] as const;
        }
      ),
      // An open goes out after its own bytes, so a live attach has them before it acts.
      Stream.runForEach(({ chunk, found }) =>
        Effect.andThen(
          Effect.forEach(
            framesOf(chunk),
            (frame) => PubSub.publish(pubsub, frame),
            { discard: true }
          ),
          Effect.forEach(found, (open) => PubSub.publish(opens, open), {
            discard: true,
          })
        )
      ),
      Effect.andThen(finish("exit")),
      Effect.catchCause((cause) =>
        // Interruption is the scope closing, which the finalizer below records itself.
        Effect.andThen(
          cause.reasons.every(Cause.isInterruptReason)
            ? Effect.void
            : Effect.logWarning(
                "the sandbox shell's output ended early",
                cause
              ),
          finish("exit")
        )
      ),
      Effect.forkScoped
    );
    // Registered after the pump's own finalizer, so it runs first: a scope close is always
    // recorded as `close` before the pump's interruption can report `exit`.
    yield* Effect.addFinalizer(() => finish("close"));

    // A subscribe racing `PubSub.shutdown` hangs, so the gone Deferred interrupts it instead.
    const attach = <A>(source: PubSub.PubSub<A>): Stream.Stream<A> =>
      Stream.unwrap(
        Effect.map(Ref.get(running), (alive) =>
          alive
            ? Stream.fromPubSub(source).pipe(
                Stream.interruptWhen(Deferred.await(gone))
              )
            : Stream.empty
        )
      );

    return {
      output: attach(pubsub),
      opens: attach(opens),
      write: shell.write,
      resize: shell.resize,
      alive: Ref.get(running),
      ended: Deferred.await(gone),
    };
  });
