// oxlint-disable no-redeclare -- a schema and its type share a name, the Effect idiom
// The HTTP API, shared by the server and web/. Only type imports from pi packages: web/ bundles this file.
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import {
  ApprovalNotFound,
  CapacityExhausted,
  ConversationArchived,
  ConversationNotFound,
  SkillNotFound,
} from "../errors.ts";

export type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
export type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
export {
  ApprovalNotFound,
  CapacityExhausted,
  ConversationArchived,
  ConversationNotFound,
  SkillNotFound,
} from "../errors.ts";

export const SandboxChoice = Schema.Literals(["none", "shell", "desktop"]);
export type SandboxChoice = typeof SandboxChoice.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Number,
  sandbox: SandboxChoice,
  sandboxId: Schema.optionalKey(Schema.String),
  vncUrl: Schema.optionalKey(Schema.String),
  title: Schema.String,
  /** `running` and `idle` have a Seat; `paused` and `archived` do not. */
  status: Schema.Literals(["running", "idle", "paused", "archived"]),
  /** True while a Pause waits for the current Run to end. */
  pausing: Schema.Boolean,
  createdAt: Schema.Number,
  pendingApprovals: Schema.Number,
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const Capabilities = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      modelInvocable: Schema.Boolean,
    })
  ),
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      status: Schema.Literals(["connected", "unavailable"]),
      error: Schema.optionalKey(Schema.String),
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, description: Schema.String })
      ),
    })
  ),
});
export type Capabilities = typeof Capabilities.Type;

export const CapacityUsage = Schema.Struct({
  resource: Schema.Literals(["seat", "shell", "desktop"]),
  limit: Schema.Number,
  holders: Schema.Array(Schema.Number),
});
export type CapacityUsage = typeof CapacityUsage.Type;

const UnknownSkill = SkillNotFound.pipe(HttpApiSchema.status(400));
const NotFound = ConversationNotFound.pipe(HttpApiSchema.status(404));
const Full = CapacityExhausted.pipe(HttpApiSchema.status(409));
const Archived = ConversationArchived.pipe(HttpApiSchema.status(409));
const ById = { id: Schema.Int };

const ConversationGroup = HttpApiGroup.make("conversations").add(
  HttpApiEndpoint.get("list", "/conversations", {
    success: Schema.Array(ConversationSummary),
  }),
  HttpApiEndpoint.post("create", "/conversations", {
    payload: Schema.Struct({
      sandbox: SandboxChoice,
      prompt: Schema.NonEmptyString,
      approvals: Schema.optionalKey(Schema.Literals(["ask", "auto"])),
    }),
    success: ConversationSummary.pipe(HttpApiSchema.status(201)),
    error: [Full, UnknownSkill],
  }),
  HttpApiEndpoint.post("send", "/conversations/:id/messages", {
    params: ById,
    payload: Schema.Struct({ prompt: Schema.NonEmptyString }),
    error: [NotFound, Full, Archived, UnknownSkill],
  }),
  // One pi-durable AgentEvent per SSE message: a snapshot first, then each commit's events.
  HttpApiEndpoint.get("events", "/conversations/:id/events", {
    params: ById,
    success: HttpApiSchema.StreamSse({ data: Schema.Json }),
    error: NotFound,
  }),
  // Give a paused Conversation a Seat, or cancel a Pause waiting for the Run of one that has a Seat.
  HttpApiEndpoint.post("resume", "/conversations/:id/resume", {
    params: ById,
    success: ConversationSummary,
    error: [NotFound, Full, Archived],
  }),
  // Free the Seat: at once when idle, otherwise once the current Run ends.
  HttpApiEndpoint.post("pause", "/conversations/:id/pause", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  // Abort the current Run; the Seat stays.
  HttpApiEndpoint.post("stop", "/conversations/:id/stop", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  HttpApiEndpoint.post("archive", "/conversations/:id/archive", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  HttpApiEndpoint.post("unarchive", "/conversations/:id/unarchive", {
    params: ById,
    success: HttpApiSchema.NoContent,
    error: NotFound,
  }),
  HttpApiEndpoint.post("approvals", "/conversations/:id/approvals", {
    params: ById,
    payload: Schema.Struct({
      key: Schema.String,
      decision: Schema.Literals(["approve", "deny", "always"]),
    }),
    success: HttpApiSchema.NoContent,
    error: [NotFound, ApprovalNotFound.pipe(HttpApiSchema.status(404))],
  })
);

const InfoGroup = HttpApiGroup.make("info").add(
  HttpApiEndpoint.get("get", "/info", {
    success: Schema.Struct({ model: Schema.String }),
  }),
  HttpApiEndpoint.get("capabilities", "/capabilities", {
    success: Capabilities,
  }),
  // Each Capacity resource's limit and holders, for choosing a Conversation to pause.
  HttpApiEndpoint.get("capacity", "/capacity", {
    success: Schema.Array(CapacityUsage),
  })
);

export const Api = HttpApi.make("effect-pi")
  .add(ConversationGroup)
  .add(InfoGroup)
  .prefix("/api");
