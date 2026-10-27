import { Duration, Effect, Fiber, Schedule, Stream } from "effect";
import type { ConversationEvent } from "effect-pi/api";
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { makeSharedSubscriptions } from "./refcount";
import { sessionLost } from "./session";
import { useConversationStore } from "./store";

/** Feed a conversation's events into the store until the returned function is called or the conversation ends. */
const startSubscription = (id: number): (() => void) => {
  const { applyAll, markEnded } = useConversationStore.getState();
  let signedOut = false;
  const subscribe = Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api, {
      baseUrl: window.location.origin,
    });
    const events = yield* client.conversations.events({ params: { id } });
    // Events that arrive together apply in one update: a commit's entry and its submission can never paint
    // both sides of the pending/committed swap.
    yield* Stream.runForEach(
      events.pipe(Stream.groupedWithin(1000, Duration.zero)),
      (batch) =>
        // The wire schema is JSON; the server sends ConversationEvents.
        Effect.sync(() => applyAll(id, batch as unknown as ConversationEvent[]))
    );
  }).pipe(
    Effect.catchTag("ConversationNotFound", () =>
      Effect.sync(() => markEnded(id))
    ),
    Effect.catchTag("Unauthorized", () =>
      Effect.sync(() => {
        signedOut = true;
        sessionLost();
      })
    ),
    // Reconnect after the stream drops (server restart, network); the next snapshot rebuilds the state. Stops once
    // the conversation is marked ended, or the session is gone.
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: () =>
        signedOut || (useConversationStore.getState().ended[id] ?? false),
    }),
    Effect.retry(Schedule.spaced("1 second")),
    Effect.provide(FetchHttpClient.layer)
  );
  const fiber = Effect.runFork(subscribe);
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

/** Shared per id: any number of callers get one stream; the last unsubscribe interrupts it. */
export const subscribeToConversation =
  makeSharedSubscriptions(startSubscription);
