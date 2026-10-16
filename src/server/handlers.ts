// Handlers for the API in api.ts. Agent and sandbox failures are defects: they surface as 500s.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  ConversationId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Schema } from "effect";
import { Effect, Layer, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Agents } from "../agents/agents.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Attachments, infoOf } from "../attachments/attachments.ts";
import type { ConversationEvent } from "../conversation-events.ts";
import {
  ArtifactNotFound,
  ConversationArchived,
  EmptyMessage,
} from "../errors.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { loopbackOnly } from "./loopback.ts";

// ConversationEvents are plain JSON (pi-durable's committed AgentEvents, and storage records); the cast only names that for the SSE schema.
const asJson = (event: ConversationEvent) => event as unknown as Schema.Json;

/** The wire shape of an admitted input: its submission's id, and its entry's once placed. */
const ackOf = (record: SubmissionRecord) => ({
  id: Number(record.id),
  status: record.status,
  ...(record.status === "placed" || record.status === "done"
    ? { entry: Number(record.entry) }
    : {}),
  ...(record.status === "unanswered"
    ? {
        reason: record.reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      }
    : {}),
});

/** A message needs text or attachments. */
const message = (payload: {
  readonly prompt?: string;
  readonly attachments?: readonly string[];
}): Effect.Effect<
  { readonly prompt: string; readonly attachments: readonly string[] },
  EmptyMessage
> => {
  const prompt = payload.prompt ?? "";
  const attachments = payload.attachments ?? [];
  return prompt.trim() === "" && attachments.length === 0
    ? Effect.fail(new EmptyMessage())
    : Effect.succeed({ prompt, attachments });
};

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
        message(payload).pipe(
          Effect.flatMap(({ prompt, attachments }) =>
            conversations.create({ ...payload, prompt, attachments })
          ),
          Effect.map(({ submission, ...summary }) => ({
            ...summary,
            submission: ackOf(submission),
          })),
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
            // A Conversation it just created is never missing or archived.
            ConversationNotFound: Effect.die,
            ConversationArchived: Effect.die,
          })
        )
      )
      .handle("send", ({ params, payload }) =>
        message(payload).pipe(
          Effect.flatMap(({ prompt, attachments }) =>
            conversations.send(
              params.id,
              prompt,
              attachments,
              payload.requestId
            )
          ),
          Effect.map(ackOf),
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("resume", ({ params }) =>
        conversations.resume(params.id).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("pause", ({ params }) =>
        conversations
          .pause(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("stop", ({ params }) =>
        conversations
          .stop(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("upgrade", ({ params, payload }) =>
        conversations.upgrade(params.id, payload.level).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("cancelWait", ({ params }) =>
        conversations.cancelWait(params.id).pipe(Effect.asVoid)
      )
      .handle("archive", ({ params }) =>
        conversations.archive(params.id).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("unarchive", ({ params }) =>
        conversations
          .unarchive(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("agent", ({ params }) =>
        conversations
          .agent(params.id)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("configure", ({ params, payload }) =>
        conversations.configure(params.id, payload).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("reset", ({ params }) =>
        conversations.reset(params.id).pipe(
          Effect.catchTags({
            AgentError: Effect.die,
            SandboxError: Effect.die,
          })
        )
      )
      .handle("events", ({ params }) =>
        conversations.events(params.id).pipe(
          Effect.map((events) => events.pipe(Stream.map(asJson), Stream.orDie)),
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("approvals", ({ params, payload }) =>
        conversations
          .decide(params.id, payload.key, payload.decision)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("answers", ({ params, payload }) =>
        conversations
          .answer(params.id, payload.key, payload.answers)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      );
  })
);

/** `Content-Disposition` for a download, with the name kept in UTF-8 and a plain fallback. */
const disposition = (name: string) => {
  const fallback = name.replaceAll(/[^\w.-]+/gu, "_") || "file";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const AttachmentsHandlers = HttpApiBuilder.group(
  Api,
  "attachments",
  Effect.fnUntraced(function* (handlers) {
    const attachments = yield* Attachments;
    const agents = yield* Agents;
    return handlers
      .handle("upload", ({ payload }) =>
        Effect.gen(function* () {
          if (payload.conversation !== undefined) {
            const stored = yield* agents.get(
              payload.conversation as ConversationId
            );
            if (stored.meta.archivedAt !== undefined) {
              return yield* new ConversationArchived({
                id: payload.conversation,
              });
            }
          }
          return yield* attachments.upload({
            path: payload.file.path,
            name: payload.file.name,
            contentType: payload.file.contentType,
            conversationId: payload.conversation,
          });
        }).pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("remove", ({ params }) => attachments.remove(params.id))
      .handle("original", ({ params, query }) =>
        attachments.file(params.id, query.conversation, "original").pipe(
          Effect.map(({ record, bytes }) =>
            // Always a download, never rendered: an HTML file must not run on this origin.
            HttpServerResponse.uint8Array(bytes, {
              contentType: record.mediaType,
              headers: {
                "content-disposition": disposition(record.name),
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox",
                "cache-control": "private, no-store",
              },
            })
          )
        )
      )
      .handle("view", ({ params, query }) =>
        attachments.view(params.id, query.conversation).pipe(
          Effect.map(({ record, prepared }) => ({
            info: infoOf(record),
            prepared,
          }))
        )
      )
      .handle("page", ({ params, query }) =>
        attachments.pageImage(params.id, query.conversation, params.page).pipe(
          Effect.map((bytes) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: "image/webp",
              headers: {
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=86400",
              },
            })
          )
        )
      )
      .handle("thumbnail", ({ params, query }) =>
        attachments.file(params.id, query.conversation, "thumbnail").pipe(
          Effect.map(({ bytes }) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: "image/webp",
              headers: {
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=86400",
              },
            })
          )
        )
      );
  })
);

/** An artifact page's sandbox: scripts only inline or from this origin's artifact-libs, nothing fetched. */
const ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

/**
 * The JavaScript a page may load, by served name: each resolves to the file of that name in its package's dist
 * folder (the entry point's directory). Anything not in the map is a 404 — pages never reach a CDN.
 */
const ARTIFACT_LIBS: Record<string, string> = {
  "chart.umd.js": "chart.js",
  "mermaid.min.js": "mermaid",
};

const require_ = createRequire(import.meta.url);

const libPath = (file: string) => {
  const pkg = ARTIFACT_LIBS[file];
  return pkg === undefined
    ? undefined
    : path.join(path.dirname(require_.resolve(pkg)), file);
};

const ArtifactsHandlers = HttpApiBuilder.group(
  Api,
  "artifacts",
  Effect.fnUntraced(function* (handlers) {
    const artifacts = yield* Artifacts;
    return handlers
      .handle("list", ({ query }) => artifacts.list(query.conversation))
      .handle("view", ({ params, query }) =>
        artifacts.view(query.conversation, params.id)
      )
      .handle("render", ({ params, query }) =>
        artifacts.html(query.conversation, params.id, query.v).pipe(
          Effect.map(({ html }) =>
            HttpServerResponse.text(html, {
              contentType: "text/html",
              headers: {
                "content-security-policy": ARTIFACT_CSP,
                "x-content-type-options": "nosniff",
                "cache-control": "no-store",
              },
            })
          )
        )
      )
      .handle("source", ({ params, query }) =>
        artifacts.html(query.conversation, params.id, query.v)
      )
      .handle("remove", ({ params, query }) =>
        artifacts.remove(query.conversation, params.id)
      )
      .handle("lib", ({ params }) => {
        const file = libPath(params.file);
        return file === undefined
          ? Effect.fail(new ArtifactNotFound({ id: params.file }))
          : Effect.promise(() => readFile(file)).pipe(
              Effect.map((bytes) =>
                HttpServerResponse.uint8Array(bytes, {
                  contentType: "text/javascript",
                  headers: {
                    "x-content-type-options": "nosniff",
                    "cache-control": "no-store",
                  },
                })
              )
            );
      });
  })
);

const InfoHandlers = HttpApiBuilder.group(
  Api,
  "info",
  Effect.fnUntraced(function* (handlers) {
    const {
      capabilities,
      model: { provider, modelId },
    } = yield* Agents;
    const { capacity } = yield* Conversations;
    const model = `${provider}/${modelId}`;
    return handlers
      .handle("get", () => Effect.succeed({ model }))
      .handle("capabilities", () => capabilities)
      .handle("capacity", () => capacity);
  })
);

export const ApiLayer = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(
    Layer.mergeAll(
      ConversationsHandlers,
      AttachmentsHandlers,
      ArtifactsHandlers,
      InfoHandlers
    )
  ),
  Layer.merge(loopbackOnly)
);
