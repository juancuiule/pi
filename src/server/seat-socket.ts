// The checks a WebSocket route under `/api/conversations/:id/...` runs before it upgrades. These routes sit
// outside the HttpApi, so `Authentication` does not run for them: each calls this instead. The `loopbackOnly`
// middleware merged into the same router has already answered 403 to a foreign Host or Origin.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type { Seat } from "../agents/agents.ts";
import { SESSION_COOKIE } from "../auth/user.ts";
import { authorize } from "./auth.ts";
import { Conversations } from "./conversations.ts";

/**
 * The caller's live Seat for the Conversation `template`'s `:id` names, or the response that refuses the
 * request: 401 without a session, 404 for an unknown id, someone else's Conversation, or one without a Seat.
 */
export const seatForSocket = (template: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const id = Number(params.id);
    if (!Number.isInteger(id) || id < 0) {
      return HttpServerResponse.text("Unknown conversation", { status: 404 });
    }
    const refusal = yield* authorize(
      request.cookies[SESSION_COOKIE] ?? "",
      template
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
    // A paused or archived Conversation has no Seat: nothing runs to connect to.
    const seat: Seat | undefined = yield* conversations.seat(id);
    return (
      seat ??
      HttpServerResponse.text("The conversation has no live seat", {
        status: 404,
      })
    );
  });
