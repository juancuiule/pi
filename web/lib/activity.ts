// One stream for all of the person's conversations: `GET /api/activity` says when a Run ended or a call started
// waiting, for conversations the console has no events stream open for. One connection for the whole console,
// whatever the number of conversations (per-conversation streams would exhaust the browser's six per host).
import { Effect, Fiber, Schedule, Stream } from "effect";
import type { Activity } from "effect-pi/api";
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/**
 * Follow the activity stream until the returned function is called, reconnecting a second after it drops.
 * `onConnect` runs on every (re)connect — what happened while it was down arrives only through a refetch.
 * Stops when the session is gone; the console's REST calls send the person to sign in.
 */
export const followActivity = (handlers: {
  readonly onConnect: () => void;
  readonly onActivity: (activity: Activity) => void;
}): (() => void) => {
  let signedOut = false;
  const follow = Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api, {
      baseUrl: window.location.origin,
    });
    const messages = yield* client.conversations.activity();
    yield* Effect.sync(handlers.onConnect);
    yield* Stream.runForEach(messages, (message) =>
      message.type === "activity"
        ? Effect.sync(() => {
            const { type: _type, ...activity } = message;
            handlers.onActivity(activity);
          })
        : Effect.void
    );
  }).pipe(
    Effect.catchTag("Unauthorized", () =>
      Effect.sync(() => {
        signedOut = true;
      })
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: () => signedOut,
    }),
    Effect.retry(Schedule.spaced("1 second")),
    Effect.provide(FetchHttpClient.layer)
  );
  const fiber = Effect.runFork(follow);
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};
