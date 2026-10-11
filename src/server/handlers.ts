// Handlers for the API in api.ts. Agent and sandbox failures are defects: they surface as 500s.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Effect, Layer, Stream } from "effect";
import type { Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";

// AgentEvents are plain JSON (they are what pi-durable commits); the cast only names that for the SSE schema.
const asJson = (event: AgentEvent) => event as unknown as Schema.Json;

const ConversationsHandlers = HttpApiBuilder.group(
  Api,
  "conversations",
  Effect.fnUntraced(function* (handlers) {
    const conversations = yield* Conversations;
    return handlers
      .handle("list", () =>
        conversations.list.pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("create", ({ payload }) =>
        conversations.create(payload).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("send", ({ params, payload }) =>
        conversations
          .send(params.id, payload.prompt)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("events", ({ params }) =>
        conversations.events(params.id).pipe(
          Effect.map((events) => events.pipe(Stream.map(asJson), Stream.orDie)),
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("end", ({ params }) => conversations.end(params.id))
      .handle("approvals", ({ params, payload }) =>
        conversations
          .decide(params.id, payload.key, payload.decision)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      );
  })
);

const infoHandlers = (info: { readonly model: string }) =>
  HttpApiBuilder.group(Api, "info", (handlers) =>
    handlers.handle("get", () => Effect.succeed(info))
  );

export const apiLayer = (info: { readonly model: string }) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.mergeAll(ConversationsHandlers, infoHandlers(info)))
  );
