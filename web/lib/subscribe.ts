import { Effect, Fiber, Schedule, Stream } from "effect";
import type { AgentEvent } from "effect-pi/api";
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { useConversationStore } from "./store";

/** Feed a conversation's events into the store until the returned function is called or the conversation ends. */
export const subscribeToConversation = (id: number): (() => void) => {
  const { apply, markEnded } = useConversationStore.getState();
  const subscribe = Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api, {
      baseUrl: window.location.origin,
    });
    const events = yield* client.conversations.events({ params: { id } });
    yield* Stream.runForEach(events, (event) =>
      // The wire schema is JSON; the server sends AgentEvents.
      Effect.sync(() => apply(id, event as unknown as AgentEvent))
    );
  }).pipe(
    Effect.catchTag("ConversationNotFound", () =>
      Effect.sync(() => markEnded(id))
    ),
    // Reconnect after the stream drops (server restart, network); the next snapshot rebuilds the state. Stops once
    // the conversation is marked ended.
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: () => useConversationStore.getState().ended[id] === true,
    }),
    Effect.retry(Schedule.spaced("1 second")),
    Effect.provide(FetchHttpClient.layer)
  );
  const fiber = Effect.runFork(subscribe);
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};
