// Dictation in the composer, served as a WebSocket upgrade on `/api/dictation` (protocol in
// src/dictation/protocol.ts): the client streams PCM, the server answers interim and final text from the
// Transcriber. Dictation belongs to the User, not to a Conversation (the New conversation form has none yet), so
// the route checks only the session; it is outside the HttpApi, so it runs `authorize` itself (401 without one).
// Without a Transcriber (TRANSCRIBE_URL unset) the route answers 404 and /api/info reports dictation off.
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { SESSION_COOKIE } from "../auth/user.ts";
import { DictationClientMessage } from "../dictation/protocol.ts";
import type { DictationServerMessage } from "../dictation/protocol.ts";
import { dictationSession } from "../dictation/session.ts";
import type { DictationOptions } from "../dictation/session.ts";
import { Transcriber } from "../dictation/transcriber.ts";
import { authorize } from "./auth.ts";

export const DICTATION_ROUTE = "/api/dictation";

const decodeClient = Schema.decodeUnknownOption(
  Schema.fromJsonString(DictationClientMessage)
);

const session = (options: DictationOptions) =>
  Effect.gen(function* () {
    const transcriber = yield* Effect.serviceOption(Transcriber);
    if (Option.isNone(transcriber)) {
      return HttpServerResponse.text("Dictation is not configured", {
        status: 404,
      });
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refusal = yield* authorize(
      request.cookies[SESSION_COOKIE] ?? "",
      DICTATION_ROUTE
    ).pipe(
      Effect.asVoid,
      Effect.catchTags({
        Unauthorized: () =>
          Effect.succeed(
            HttpServerResponse.text("Sign in first", { status: 401 })
          ),
        ConversationNotFound: () =>
          Effect.succeed(
            HttpServerResponse.text("Unknown conversation", { status: 404 })
          ),
      })
    );
    if (HttpServerResponse.isHttpServerResponse(refusal)) {
      return refusal;
    }
    const upgraded = yield* Effect.exit(request.upgrade);
    if (Exit.isFailure(upgraded)) {
      return HttpServerResponse.text("Not an upgrade request", { status: 400 });
    }
    const socket = upgraded.value;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const acquired = yield* Effect.exit(
          Effect.zip(socket.writer, socket.reader)
        );
        if (Exit.isFailure(acquired)) {
          return;
        }
        const [writer, reader] = acquired.value;
        const send = (message: DictationServerMessage) =>
          Effect.ignore(writer.write(JSON.stringify(message)));
        const end = Effect.ignore(
          writer.write(new Socket.CloseEvent(1000, "done"))
        );

        // Frames arrive in batches; the first must be `start`.
        const pending: (string | Uint8Array)[] = [];
        const next = Effect.gen(function* () {
          while (pending.length === 0) {
            pending.push(...(yield* reader.pull));
          }
          return pending.shift();
        });
        const first = yield* Effect.exit(next);
        const start =
          Exit.isSuccess(first) && typeof first.value === "string"
            ? Option.getOrUndefined(decodeClient(first.value))
            : undefined;
        if (start?.type !== "start") {
          if (Exit.isSuccess(first)) {
            yield* send({
              type: "error",
              reason: "protocol",
              message: "The first frame must be a start message",
            });
            yield* end;
          }
          return;
        }

        const dictation = yield* dictationSession({
          ...options,
          language: start.language,
          send,
        }).pipe(Effect.provideService(Transcriber, transcriber.value));
        const worker = yield* dictation.run.pipe(
          Effect.tap((stats) =>
            Effect.annotateCurrentSpan({
              "dictation.seconds": stats.seconds,
              "dictation.segments": stats.segments,
              "dictation.requests": stats.requests,
              "dictation.outcome": stats.outcome,
              "dictation.language": start.language ?? "auto",
            })
          ),
          Effect.withSpan("Dictation.session"),
          Effect.forkChild
        );

        // Client → session until `stop`, `cancel` or the socket going away; a cancel or a drop interrupts the
        // worker, so nothing more is transcribed or sent.
        const read: Effect.Effect<"stop" | "cancel"> = Effect.gen(function* () {
          while (true) {
            const frame = yield* next;
            if (frame === undefined) {
              continue;
            }
            if (typeof frame !== "string") {
              yield* dictation.audio(frame);
              continue;
            }
            const message = Option.getOrUndefined(decodeClient(frame));
            if (message?.type === "stop") {
              yield* dictation.stop;
              return "stop" as const;
            }
            if (message?.type === "cancel") {
              return "cancel" as const;
            }
          }
        }).pipe(Effect.catchCause(() => Effect.succeed("cancel" as const)));

        const reading = yield* Effect.forkChild(read);
        // The worker ends on its own only by failing; the reader, on stop, cancel or a drop.
        const ended = yield* Effect.raceFirst(
          Fiber.join(reading),
          Effect.as(Fiber.await(worker), "worker" as const)
        );
        yield* ended === "cancel"
          ? Fiber.interrupt(worker)
          : Effect.asVoid(Fiber.await(worker));
        yield* Fiber.interrupt(reading);
        yield* end;
      })
    );
    return HttpServerResponse.empty();
  });

/** The dictation WebSocket route, merged into the router `apiLayer` serves. */
export const dictationRoute = (options: DictationOptions) =>
  HttpRouter.add("GET", DICTATION_ROUTE, session(options));
