// oxlint-disable no-redeclare -- a schema and its type share a name, the Effect idiom
// The HTTP API, shared by the server and web/. Only type imports from pi packages: web/ bundles this file.
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { ConversationNotFound, SandboxLimitReached } from "../errors.ts";

export type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
export type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
export { ConversationNotFound, SandboxLimitReached } from "../errors.ts";

export const SandboxChoice = Schema.Literals(["none", "shell", "desktop"]);
export type SandboxChoice = typeof SandboxChoice.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Number,
  sandbox: SandboxChoice,
  sandboxId: Schema.optionalKey(Schema.String),
  vncUrl: Schema.optionalKey(Schema.String),
  title: Schema.String,
  status: Schema.Literals(["running", "idle"]),
  createdAt: Schema.Number,
});
export type ConversationSummary = typeof ConversationSummary.Type;

const NotFound = ConversationNotFound.pipe(HttpApiSchema.status(404));
const ById = { id: Schema.Int };

export const Api = HttpApi.make("effect-pi")
  .add(
    HttpApiGroup.make("conversations").add(
      HttpApiEndpoint.get("list", "/conversations", {
        success: Schema.Array(ConversationSummary),
      }),
      HttpApiEndpoint.post("create", "/conversations", {
        payload: Schema.Struct({
          sandbox: SandboxChoice,
          prompt: Schema.NonEmptyString,
        }),
        success: ConversationSummary.pipe(HttpApiSchema.status(201)),
        error: SandboxLimitReached.pipe(HttpApiSchema.status(409)),
      }),
      HttpApiEndpoint.post("send", "/conversations/:id/messages", {
        params: ById,
        payload: Schema.Struct({ prompt: Schema.NonEmptyString }),
        error: NotFound,
      }),
      // One pi-durable AgentEvent per SSE message: a snapshot first, then each commit's events.
      HttpApiEndpoint.get("events", "/conversations/:id/events", {
        params: ById,
        success: HttpApiSchema.StreamSse({ data: Schema.Json }),
        error: NotFound,
      }),
      HttpApiEndpoint.delete("end", "/conversations/:id", {
        params: ById,
        error: NotFound,
      })
    )
  )
  .add(
    HttpApiGroup.make("info").add(
      HttpApiEndpoint.get("get", "/info", {
        success: Schema.Struct({ model: Schema.String }),
      })
    )
  )
  .prefix("/api");
